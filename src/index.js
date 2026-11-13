require("dotenv").config();
const express = require("express");
const path = require("node:path");
const {
  Client, GatewayIntentBits, SlashCommandBuilder, SlashCommandSubcommandBuilder,
  REST, Routes, PermissionFlagsBits
} = require("discord.js");
const { playAlarmSequence } = require("./voice");

const app = express();
const allowedOrigins = (process.env.WEB_ALLOWED_ORIGINS || "https://buhntech-dev.github.io")
  .split(",").map(origin => origin.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_IDS = (process.env.VOICE_CHANNEL_IDS || process.env.VOICE_CHANNEL_ID || "")
  .split(",").map(id => id.trim()).filter(Boolean);
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || "1559922761546203276";
const WEBHOOK_SECRET = process.env.ALARM_WEBHOOK_SECRET;
const TIME_ZONE = process.env.TIME_ZONE || "Europe/Berlin";
const SCHEDULE_MARKER = "[BEDARFSMELDER_PROBEPLAN_V1]";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let alarmQueue = Promise.resolve();
let lastAlarmAt = null;
let alarmCount = 0;
const alarmHistory = [];
let scheduleMessage = null;
let probeSchedule = null;
let lastScheduleMinute = null;

function clean(value, max = 500) {
  return String(value || "").trim().replace(/[\u0000-\u001f]/g, " ").slice(0, max);
}
function makeAnnouncement(body) {
  const parts = [
    "Alarmierung der Feuerwehr und des Rettungsdienstes.",
    body.probealarm ? "Dies ist ein Probealarm." : "Es liegt ein neuer Einsatz vor.",
    body.stichwort ? "Stichwort: " + clean(body.stichwort, 120) + "." : "",
    body.plz ? "Postleitzahl: " + clean(body.plz, 12) + "." : "",
    body.adresse ? "Einsatzort: " + clean(body.adresse, 180) + "." : "",
    body.meldebild ? "Meldebild: " + clean(body.meldebild, 350) + "." : "",
    body.fahrzeuge ? "Alarmierte Kräfte: " + clean(Array.isArray(body.fahrzeuge) ? body.fahrzeuge.join(", ") : body.fahrzeuge, 180) + "." : "",
    body.hinweis ? "Zusatzinformation: " + clean(body.hinweis, 250) + "." : ""
  ].filter(Boolean);
  return parts.join(" ");
}
async function sendAnnouncementMessage(body, announcement, source) {
  try {
    const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
    if (!channel?.isTextBased() || !channel.send) throw new Error("Der Meldekanal ist kein beschreibbarer Textkanal.");
    const heading = body.probealarm ? "🧪 **PROBEALARM**" : "🚨 **NEUE ALARMIERUNG**";
    await channel.send({
      content: heading + "\n" + announcement + "\n\nQuelle: " + clean(source, 80),
      allowedMentions: { parse: [] }
    });
    console.log("[ANNOUNCEMENT] Nachricht in Kanal " + ANNOUNCEMENT_CHANNEL_ID + " gesendet.");
  } catch (error) {
    console.error("[ANNOUNCEMENT ERROR]", error);
    throw new Error("Sprachdurchsage wurde ausgelöst, aber Nachricht im Meldekanal fehlgeschlagen: " + error.message);
  }
}
async function queueAlarm(body, source = "Webhook") {
  const announcement = makeAnnouncement(body);
  if (!announcement || announcement.length < 10) throw new Error("Die Einsatzmeldung ist leer.");
  const task = alarmQueue.catch(() => {}).then(async () => {
    alarmCount++;
    lastAlarmAt = new Date().toISOString();
    console.log("[ALARM] #" + alarmCount + " von " + source + ": " + announcement);
    const voiceTask = playAlarmSequence(client, {
      guildId: clean(body.guildId || GUILD_ID, 32),
      channelIds: body.channelId ? [clean(body.channelId, 32)] : VOICE_CHANNEL_IDS,
      announcement,
      audioUrl: clean(body.audioUrl || process.env.ALARM_AUDIO_URL, 1500)
    });
    const messageTask = sendAnnouncementMessage(body, announcement, source);
    const results = await Promise.allSettled([voiceTask, messageTask]);
    const errors = results.filter(r => r.status === "rejected").map(r => r.reason?.message || String(r.reason));
    if (errors.length) throw new Error(errors.join(" | "));
  });
  alarmQueue = task.catch(() => {});
  return task;
}

function getBerlinParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
const weekdayNumbers = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const weekdayNames = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
function scheduleLabel(s) {
  return weekdayNames[s.weekday] + " um " + s.time + " Uhr (" + TIME_ZONE + ")";
}
async function findScheduleMessage(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  return messages.find(m => m.author.id === client.user.id && m.content.includes(SCHEDULE_MARKER)) || null;
}
async function saveSchedule() {
  const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
  if (!channel?.isTextBased() || !channel.send) throw new Error("Meldekanal nicht verfügbar oder keine Schreibrechte.");
  const payload = SCHEDULE_MARKER + "\n" + JSON.stringify(probeSchedule);
  if (scheduleMessage) await scheduleMessage.edit({ content: payload });
  else {
    scheduleMessage = await findScheduleMessage(channel);
    if (scheduleMessage) await scheduleMessage.edit({ content: payload });
    else scheduleMessage = await channel.send({ content: payload, allowedMentions: { parse: [] } });
  }
}
async function loadSchedule() {
  try {
    const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    scheduleMessage = await findScheduleMessage(channel);
    if (scheduleMessage) {
      const raw = scheduleMessage.content.split("\n").slice(1).join("\n");
      const parsed = JSON.parse(raw);
      if (parsed && Number.isInteger(parsed.weekday) && /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.time)) {
        probeSchedule = parsed;
        lastScheduleMinute = parsed.lastRun || null;
        console.log("[PROBE] Wöchentlicher Probealarm geladen: " + scheduleLabel(probeSchedule));
      }
    }
  } catch (error) {
    console.error("[PROBE] Zeitplan konnte nicht geladen werden:", error);
  }
}
async function checkScheduledProbe() {
  if (!probeSchedule) return;
  const now = getBerlinParts();
  const weekday = weekdayNumbers[now.weekday];
  const minuteKey = new Date().toISOString().slice(0, 16);
  if (weekday !== probeSchedule.weekday || now.hour + ":" + now.minute !== probeSchedule.time || lastScheduleMinute === minuteKey) return;
  lastScheduleMinute = minuteKey;
  probeSchedule.lastRun = minuteKey;
  try { await saveSchedule(); } catch (error) { console.error("[PROBE] Laufzeit konnte nicht gespeichert werden:", error); }
  queueAlarm({
    probealarm: true,
    stichwort: "Regelmäßiger Probealarm",
    meldebild: "Automatisch geplanter wöchentlicher Funktionstest"
  }, "Automatischer Probealarm").catch(error => console.error("[PROBE ERROR]", error));
}

app.get("/health", (_req, res) => res.json({
  ok: true, bot: client.isReady(), alarmCount, lastAlarmAt,
  probeSchedule: probeSchedule ? scheduleLabel(probeSchedule) : null
}));
app.get("/api/status", (_req, res) => res.json({
  ready: client.isReady(), bot: client.user?.tag || null,
  voiceChannelConfigured: VOICE_CHANNEL_IDS.length > 0,
  voiceChannelsConfigured: VOICE_CHANNEL_IDS.length,
  announcementChannelConfigured: Boolean(ANNOUNCEMENT_CHANNEL_ID),
  probeSchedule: probeSchedule ? scheduleLabel(probeSchedule) : null,
  alarmCount, lastAlarmAt
}));
app.get("/api/channels", async (_req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channels = [];
    for (const id of VOICE_CHANNEL_IDS) {
      const channel = await guild.channels.fetch(id).catch(() => null);
      if (channel && channel.isVoiceBased()) channels.push({ id: channel.id, name: channel.name, type: "voice" });
    }
    res.json({ ok: true, channels });
  } catch (error) {
    console.error("[CHANNELS]", error);
    res.status(503).json({ ok: false, error: "Discord-Kanäle konnten nicht geladen werden." });
  }
});
app.get("/api/alarms", (_req, res) => res.json({ ok: true, alarms: alarmHistory }));
app.post("/api/alarm", async (req, res) => {
  if (!WEBHOOK_SECRET || req.get("authorization") !== "Bearer " + WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  }
  try {
    await queueAlarm(req.body || {}, "Leitstelle/Webhook");
    res.json({ ok: true, message: "Alarmton, Sprachdurchsage und Discord-Meldung verarbeitet." });
  } catch (error) {
    console.error("[ALARM ERROR]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => console.log("[WEB] Bedarfsmelder hört auf Port " + PORT));

const probeCommand = new SlashCommandBuilder()
  .setName("probe")
  .setDescription("Wöchentlichen Probealarm verwalten.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub => sub
    .setName("festlegen")
    .setDescription("Wöchentlichen Probealarm festlegen.")
    .addIntegerOption(o => o.setName("wochentag").setDescription("Tag des Probealarms").setRequired(true)
      .addChoices(
        { name: "Montag", value: 1 }, { name: "Dienstag", value: 2 },
        { name: "Mittwoch", value: 3 }, { name: "Donnerstag", value: 4 },
        { name: "Freitag", value: 5 }, { name: "Samstag", value: 6 }, { name: "Sonntag", value: 0 }
      ))
    .addStringOption(o => o.setName("uhrzeit").setDescription("Uhrzeit im Format HH:MM, z. B. 18:30").setRequired(true).setMinLength(5).setMaxLength(5)))
  .addSubcommand(sub => sub.setName("status").setDescription("Aktuellen Probealarm-Zeitplan anzeigen."))
  .addSubcommand(sub => sub.setName("loeschen").setDescription("Geplanten Probealarm entfernen."))
  .toJSON();

const commands = [
  new SlashCommandBuilder()
    .setName("alarm")
    .setDescription("Löst einen Einsatzalarm mit Ton, Sprachdurchsage und Discord-Nachricht aus.")
    .addStringOption(o => o.setName("stichwort").setDescription("Einsatzstichwort").setRequired(true).setMaxLength(120))
    .addStringOption(o => o.setName("adresse").setDescription("Einsatzadresse").setRequired(true).setMaxLength(180))
    .addStringOption(o => o.setName("plz").setDescription("Postleitzahl").setRequired(false).setMaxLength(12))
    .addStringOption(o => o.setName("meldebild").setDescription("Was ist passiert?").setRequired(false).setMaxLength(350))
    .addStringOption(o => o.setName("fahrzeuge").setDescription("Alarmierte Fahrzeuge").setRequired(false).setMaxLength(180))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
  new SlashCommandBuilder()
    .setName("probealarm")
    .setDescription("Löst sofort einen gekennzeichneten Probealarm aus.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
  probeCommand
];

client.once("ready", async () => {
  console.log("[DISCORD] Eingeloggt als " + client.user.tag);
  try {
    const applicationId = client.application?.id || CLIENT_ID;
    if (!applicationId) throw new Error("Application-ID konnte nicht ermittelt werden.");
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(applicationId, GUILD_ID), { body: commands });
    console.log("[COMMANDS] /alarm, /probealarm und /probe erfolgreich auf Server " + GUILD_ID + " registriert.");
  } catch (error) {
    console.error("[COMMAND REGISTRATION ERROR]", error);
  }
  await loadSchedule();
  setInterval(checkScheduledProbe, 15000);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!["alarm", "probealarm", "probe"].includes(interaction.commandName)) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    if (interaction.commandName === "alarm") {
      await queueAlarm({
        stichwort: interaction.options.getString("stichwort"),
        adresse: interaction.options.getString("adresse"),
        plz: interaction.options.getString("plz"),
        meldebild: interaction.options.getString("meldebild"),
        fahrzeuge: interaction.options.getString("fahrzeuge")
      }, "Discord /alarm");
      return interaction.editReply("✅ Alarm wurde verarbeitet: Sprachkanäle und Meldekanal.");
    }
    if (interaction.commandName === "probealarm") {
      await queueAlarm({
        probealarm: true, stichwort: "Manueller Probealarm",
        meldebild: "Manuell ausgelöster Funktionstest"
      }, "Discord /probealarm");
      return interaction.editReply("✅ Probealarm wurde ausgelöst.");
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "festlegen") {
      const weekday = interaction.options.getInteger("wochentag");
      const time = interaction.options.getString("uhrzeit");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        return interaction.editReply("❌ Bitte die Uhrzeit als HH:MM eingeben, zum Beispiel 18:30.");
      }
      probeSchedule = { weekday, time, lastRun: null };
      await saveSchedule();
      return interaction.editReply("✅ Wöchentlicher Probealarm festgelegt: " + scheduleLabel(probeSchedule) + ".");
    }
    if (sub === "status") {
      return interaction.editReply(probeSchedule
        ? "🧪 Geplanter Probealarm: " + scheduleLabel(probeSchedule) + "."
        : "ℹ️ Es ist derzeit kein Probealarm geplant.");
    }
    if (sub === "loeschen") {
      probeSchedule = null;
      if (scheduleMessage) {
        await scheduleMessage.delete().catch(() => {});
        scheduleMessage = null;
      }
      return interaction.editReply("✅ Der geplante Probealarm wurde entfernt.");
    }
  } catch (error) {
    console.error("[COMMAND ERROR]", error);
    await interaction.editReply("❌ Fehler: " + error.message);
  }
});

client.on("error", error => console.error("[DISCORD]", error));
if (TOKEN) client.login(TOKEN).catch(error => console.error("[LOGIN]", error));
else console.warn("[CONFIG] DISCORD_TOKEN fehlt – Webserver läuft, Discord-Bot wartet auf Konfiguration.");
