require("dotenv").config();
const express = require("express");
const path = require("node:path");
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require("discord.js");
const { playAlarmSequence } = require("./voice");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_IDS = (process.env.VOICE_CHANNEL_IDS || process.env.VOICE_CHANNEL_ID || "")
  .split(",").map(id => id.trim()).filter(Boolean);
const WEBHOOK_SECRET = process.env.ALARM_WEBHOOK_SECRET;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let alarmQueue = Promise.resolve();
let lastAlarmAt = null;
let alarmCount = 0;

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
async function queueAlarm(body, source = "Webhook") {
  const announcement = makeAnnouncement(body);
  if (!announcement || announcement.length < 10) throw new Error("Die Einsatzmeldung ist leer.");
  alarmQueue = alarmQueue.then(async () => {
    alarmCount++;
    lastAlarmAt = new Date().toISOString();
    console.log("[ALARM] #" + alarmCount + " von " + source + ": " + announcement);
    await playAlarmSequence(client, {
      guildId: clean(body.guildId || GUILD_ID, 32),
      channelIds: body.channelId ? [clean(body.channelId, 32)] : VOICE_CHANNEL_IDS,
      announcement,
      audioUrl: clean(body.audioUrl || process.env.ALARM_AUDIO_URL, 1500)
    });
  });
  return alarmQueue;
}

app.get("/health", (_req, res) => res.json({
  ok: true, bot: client.isReady(), queued: alarmQueue !== Promise.resolve(),
  alarmCount, lastAlarmAt
}));
app.get("/api/status", (_req, res) => res.json({
  ready: client.isReady(), bot: client.user?.tag || null,
  voiceChannelConfigured: VOICE_CHANNEL_IDS.length > 0, voiceChannelsConfigured: VOICE_CHANNEL_IDS.length, alarmCount, lastAlarmAt
}));
app.post("/api/alarm", async (req, res) => {
  if (!WEBHOOK_SECRET || req.get("authorization") !== "Bearer " + WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  }
  try {
    await queueAlarm(req.body || {}, "Leitstelle/Webhook");
    res.json({ ok: true, message: "Alarm vollständig abgespielt und vorgelesen." });
  } catch (error) {
    console.error("[ALARM ERROR]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => console.log("[WEB] Bedarfsmelder hört auf Port " + PORT));

const commands = [
  new SlashCommandBuilder()
    .setName("alarm")
    .setDescription("Löst einen Bedarfsmelder-Alarm mit Ton und Sprachdurchsage aus.")
    .addStringOption(o => o.setName("stichwort").setDescription("Einsatzstichwort").setRequired(true).setMaxLength(120))
    .addStringOption(o => o.setName("adresse").setDescription("Einsatzadresse").setRequired(true).setMaxLength(180))
    .addStringOption(o => o.setName("plz").setDescription("Postleitzahl").setRequired(false).setMaxLength(12))
    .addStringOption(o => o.setName("meldebild").setDescription("Was ist passiert?").setRequired(false).setMaxLength(350))
    .addStringOption(o => o.setName("fahrzeuge").setDescription("Alarmierte Fahrzeuge").setRequired(false).setMaxLength(180))
    .addBooleanOption(o => o.setName("probealarm").setDescription("Als Probealarm kennzeichnen").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON()
];

client.once("ready", async () => {
  console.log("[DISCORD] Eingeloggt als " + client.user.tag);
  try {
    const applicationId = client.application?.id || CLIENT_ID;
    if (!applicationId) throw new Error("Application-ID konnte nicht ermittelt werden.");
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(applicationId, GUILD_ID), { body: commands });
      console.log("[COMMANDS] /alarm erfolgreich auf Server " + GUILD_ID + " registriert.");
    } else {
      await rest.put(Routes.applicationCommands(applicationId), { body: commands });
      console.log("[COMMANDS] /alarm global registriert. Die Anzeige kann bis zu 1 Stunde dauern.");
    }
  } catch (error) {
    console.error("[COMMAND REGISTRATION ERROR]", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "alarm") return;
  await interaction.deferReply({ ephemeral: true });
  try {
    await queueAlarm({
      stichwort: interaction.options.getString("stichwort"),
      adresse: interaction.options.getString("adresse"),
      plz: interaction.options.getString("plz"),
      meldebild: interaction.options.getString("meldebild"),
      fahrzeuge: interaction.options.getString("fahrzeuge"),
      probealarm: interaction.options.getBoolean("probealarm") || false
    }, "Discord /alarm");
    await interaction.editReply("✅ Alarmton vollständig abgespielt und Meldung vorgelesen.");
  } catch (error) {
    console.error(error);
    await interaction.editReply("❌ Alarm fehlgeschlagen: " + error.message);
  }
});

client.on("error", error => console.error("[DISCORD]", error));
if (TOKEN) client.login(TOKEN).catch(error => console.error("[LOGIN]", error));
else console.warn("[CONFIG] DISCORD_TOKEN fehlt – Webserver läuft, Discord-Bot wartet auf Konfiguration.");
