require("dotenv").config();
const express = require("express");
const path = require("node:path");
const {
  Client, GatewayIntentBits, SlashCommandBuilder, SlashCommandSubcommandBuilder,
  REST, Routes, ChannelType
} = require("discord.js");

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
const COMMAND_ROLE_ID = "1565059308641853601";
const AUTO_ADMIN_ROLE_ID = "1568033229972181022";
const SCHEDULE_MARKER = "[BEDARFSMELDER_PROBEPLAN_V1]";
const VEHICLE_MARKER = "[BEDARFSMELDER_FAHRZEUGE_V1]";
let vehicles = [];
const WEB_VOICE_CATEGORY_NAME = "Website-Sprachkanäle";

async function getWebVoiceCategory(guild, create = false) {
  const channels = await guild.channels.fetch();
  let category = channels.find(channel => channel && channel.type === ChannelType.GuildCategory && channel.name === WEB_VOICE_CATEGORY_NAME);
  if (!category && create) category = await guild.channels.create({ name: WEB_VOICE_CATEGORY_NAME, type: ChannelType.GuildCategory });
  return category || null;
}
async function createWebsiteVoiceChannel(guild, name) {
  const category = await getWebVoiceCategory(guild, true);
  // Discord kann bestimmte automatisch gesetzte Kanal-Themen ablehnen.
  // Die Website erkennt diese Kanäle ausschließlich über die Kategorie.
  return guild.channels.create({ name, type: ChannelType.GuildVoice, parent: category.id });
}

async function memberHasCommandRole(interaction) {
  const roleCache = interaction.member?.roles?.cache;
  if (roleCache?.has(COMMAND_ROLE_ID)) return true;
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    return member.roles.cache.has(COMMAND_ROLE_ID);
  } catch (error) {
    console.error("[ROLE CHECK] Mitglied/Rolle konnte nicht geprüft werden:", error.message);
    return false;
  }
}


const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let alarmQueue = Promise.resolve();
let lastAlarmAt = null;
let alarmCount = 0;
const alarmHistory = [];
const webVoiceListeners = new Map();
const liveVoicePeers = new Map();
async function isWebVoiceChannel(channelId) {
  if (VOICE_CHANNEL_IDS.includes(channelId)) return true;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) return false;
    const guild = await client.guilds.fetch(GUILD_ID);
    const category = await getWebVoiceCategory(guild, false);
    return !!category && channel.parentId === category.id;
  } catch { return false; }
}
function sendVoiceEvent(channelId, event, payload, exceptPeer = null) {
  const peers = liveVoicePeers.get(channelId); if (!peers) return;
  const data = "event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
  for (const [peerId, response] of peers) if (peerId !== exceptPeer) response.write(data);
}
async function broadcastWebAlarm(body, announcement, source) {
  for (const [channelId, listeners] of webVoiceListeners) {
    if (body.channelId && body.channelId !== channelId) continue;
    let sound = "alarm";
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.name === "Auf Wache") sound = "theatergong";
    } catch {}
    const payload = JSON.stringify({ announcement, source, sound, at: new Date().toISOString(), probealarm: !!body.probealarm });
    for (const response of listeners) response.write("event: alarm\ndata: " + payload + "\n\n");
  }
}
let scheduleMessage = null;
let probeSchedule = null;
let lastScheduleMinute = null;

function clean(value, max = 500) {
  return String(value || "").trim().replace(/[\u0000-\u001f]/g, " ").slice(0, max);
}
function makeAnnouncement(body) {
  const parts = [
    "NEUE ALARMIERUNG. ALARM für die Berufsfeuerwehr Freiburg und den Rettungsdienst.",
    body.probealarm ? "Dies ist ein Probealarm." : "Es liegt ein neuer Einsatz vor.",
    body.stichwort ? "Stichwort: " + clean(body.stichwort, 120) : "",
    body.plz ? "Postleitzahl: " + clean(body.plz, 12) : "",
    body.adresse ? "Einsatzort: " + clean(body.adresse, 180) : "",
    body.meldebild ? "Meldebild: " + clean(body.meldebild, 350) : "",
    body.fahrzeuge ? "Alarmierte Kräfte: " + clean(Array.isArray(body.fahrzeuge) ? body.fahrzeuge.map(v => typeof v === "string" ? v : [v.funkrufname, v.name].filter(Boolean).join(" ")).join(", ") : body.fahrzeuge, 500) : "",
    body.hinweis ? "Zusatzinformation: " + clean(body.hinweis, 250) : ""
  ].filter(Boolean);
  return parts.join("\n");
}
async function sendAnnouncementMessage(body, announcement, source) {
  try {
    const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
    if (!channel?.isTextBased() || !channel.send) throw new Error("Der Meldekanal ist kein beschreibbarer Textkanal.");
    const heading = body.probealarm ? "🧪 **PROBEALARM**" : "🚨 **NEUE ALARMIERUNG**";
    await channel.send({
      content: heading + "\n" + announcement,
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
    alarmHistory.unshift({ id: alarmCount, at: lastAlarmAt, source, probealarm: !!body.probealarm, stichwort: clean(body.stichwort, 120), plz: clean(body.plz, 12), adresse: clean(body.adresse, 180), meldebild: clean(body.meldebild, 350), fahrzeuge: clean(Array.isArray(body.fahrzeuge) ? body.fahrzeuge.join(", ") : body.fahrzeuge, 180), status: "wird alarmiert" });
    if (alarmHistory.length > 30) alarmHistory.length = 30;
    console.log("[ALARM] #" + alarmCount + " von " + source + ": " + announcement);
    await broadcastWebAlarm(body, announcement, source);
    await sendAnnouncementMessage(body, announcement, source);
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
async function findVehicleMessage(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  return messages.find(m => m.author.id === client.user.id && m.content.includes(VEHICLE_MARKER)) || null;
}
async function saveVehicles() {
  const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
  if (!channel?.isTextBased() || !channel.send) throw new Error("Meldekanal nicht verfügbar oder keine Schreibrechte.");
  const payload = VEHICLE_MARKER + "\n" + JSON.stringify(vehicles);
  const message = await findVehicleMessage(channel);
  if (message) await message.edit({ content: payload });
  else await channel.send({ content: payload, allowedMentions: { parse: [] } });
}
async function loadVehicles() {
  try {
    const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    const message = await findVehicleMessage(channel);
    if (message) {
      const parsed = JSON.parse(message.content.split("\n").slice(1).join("\n"));
      if (Array.isArray(parsed)) vehicles = parsed.filter(v => v && v.funkrufname && v.name);
    }
    console.log("[FAHRZEUGE] " + vehicles.length + " Fahrzeuge geladen.");
  } catch (error) { console.error("[FAHRZEUGE] Laden fehlgeschlagen:", error); }
}
async function ensureDefaultVoiceChannels() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const category = await getWebVoiceCategory(guild, true);
  const channels = await guild.channels.fetch();
  for (const name of ["Bedingt verfügbar", "Auf Wache"]) {
    if (!channels.some(channel => channel && channel.type === ChannelType.GuildVoice && channel.parentId === category.id && channel.name === name)) {
      await guild.channels.create({ name, type: ChannelType.GuildVoice, parent: category.id });
      console.log("[VOICE CHANNEL] Standardkanal erstellt: " + name);
    }
  }
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
    const allChannels = await guild.channels.fetch();
    const channels = allChannels
      .filter(channel => channel && channel.isVoiceBased() &&
        (VOICE_CHANNEL_IDS.includes(channel.id) || (channel.parentId && allChannels.get(channel.parentId)?.name === WEB_VOICE_CATEGORY_NAME)))
      .map(channel => ({ id: channel.id, name: channel.name, type: "voice", sound: channel.name === "Auf Wache" ? "theatergong" : "alarm", description: channel.name === "Auf Wache" ? "Neuer Theatergong" : channel.name === "Bedingt verfügbar" ? "Bisheriger Melderton" : "Live-Sprachkanal" }));
    res.json({ ok: true, channels });
  } catch (error) {
    console.error("[CHANNELS]", error);
    res.status(503).json({ ok: false, error: "Discord-Kanäle konnten nicht geladen werden." });
  }
});
app.get("/api/alarms", (_req, res) => res.json({ ok: true, alarms: alarmHistory }));
app.get("/api/stream/:channelId", async (req, res) => {
  const channelId = clean(req.params.channelId, 32);
  const peerId = clean(req.query.peerId, 80);
  if (!await isWebVoiceChannel(channelId)) return res.status(404).json({ ok: false, error: "Unbekannter Sprachkanal." });
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "Access-Control-Allow-Origin": allowedOrigins[0] || "*" });
  res.write("retry: 3000\n\n");
  if (!webVoiceListeners.has(channelId)) webVoiceListeners.set(channelId, new Set());
  webVoiceListeners.get(channelId).add(res);
  if (peerId) {
    if (!liveVoicePeers.has(channelId)) liveVoicePeers.set(channelId, new Map());
    const peers = liveVoicePeers.get(channelId);
    res.write("event: peer-list\ndata: " + JSON.stringify({ peers: Array.from(peers.keys()) }) + "\n\n");
    peers.set(peerId, res);
    sendVoiceEvent(channelId, "peer-joined", { peerId }, peerId);
  }
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20000);
  req.on("close", () => {
    clearInterval(keepAlive);
    webVoiceListeners.get(channelId)?.delete(res);
    if (webVoiceListeners.get(channelId)?.size === 0) webVoiceListeners.delete(channelId);
    if (peerId && liveVoicePeers.get(channelId)?.get(peerId) === res) {
      liveVoicePeers.get(channelId).delete(peerId);
      sendVoiceEvent(channelId, "peer-left", { peerId });
      if (liveVoicePeers.get(channelId).size === 0) liveVoicePeers.delete(channelId);
    }
  });
});
app.post("/api/voice/:channelId/signal", async (req, res) => {
  const channelId = clean(req.params.channelId, 32);
  const from = clean(req.body?.from, 80), to = clean(req.body?.to, 80), signal = req.body?.signal;
  if (!from || !to || !signal || !await isWebVoiceChannel(channelId)) return res.status(400).json({ ok: false, error: "Ungültige Sprachverbindung." });
  const target = liveVoicePeers.get(channelId)?.get(to);
  if (!target) return res.status(404).json({ ok: false, error: "Teilnehmer nicht mehr verbunden." });
  target.write("event: signal\ndata: " + JSON.stringify({ from, signal }) + "\n\n");
  res.json({ ok: true });
});
app.post("/api/channels", async (req, res) => {
  if (!process.env.WEB_ADMIN_SECRET || req.get("authorization") !== "Bearer " + process.env.WEB_ADMIN_SECRET)
    return res.status(401).json({ ok: false, error: "Nur Admins dürfen Sprachkanäle erstellen." });
  try {
    const name = clean(req.body?.name, 90);
    if (name.length < 2) return res.status(400).json({ ok: false, error: "Kanalname muss mindestens 2 Zeichen haben." });
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await createWebsiteVoiceChannel(guild, name);
    res.status(201).json({ ok: true, channel: { id: channel.id, name: channel.name } });
  } catch (error) {
    console.error("[CHANNEL CREATE]", error);
    res.status(500).json({ ok: false, error: "Kanal konnte nicht erstellt werden." });
  }
});
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
    .addStringOption(o => o.setName("fahrzeug1").setDescription("Erstes Fahrzeug").setRequired(false).setAutocomplete(true))
    .addStringOption(o => o.setName("fahrzeug2").setDescription("Zweites Fahrzeug").setRequired(false).setAutocomplete(true))
    .addStringOption(o => o.setName("fahrzeug3").setDescription("Drittes Fahrzeug").setRequired(false).setAutocomplete(true))
    .addStringOption(o => o.setName("fahrzeug4").setDescription("Viertes Fahrzeug").setRequired(false).setAutocomplete(true))
    .addStringOption(o => o.setName("fahrzeug5").setDescription("Fünftes Fahrzeug").setRequired(false).setAutocomplete(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("auto")
    .setDescription("Fahrzeuge für Alarmierungen verwalten (nur Admin-Rolle).")
    .addSubcommand(sub => sub.setName("erstellen").setDescription("Neues Einsatzfahrzeug anlegen.")
      .addStringOption(o => o.setName("funkrufname").setDescription("Funkrufname, z. B. Florian Freiburg 1/10-1").setRequired(true).setMaxLength(80))
      .addStringOption(o => o.setName("name").setDescription("Fahrzeugname, z. B. HLF 1").setRequired(true).setMaxLength(80)))
    .addSubcommand(sub => sub.setName("liste").setDescription("Alle gespeicherten Fahrzeuge anzeigen."))
    .addSubcommand(sub => sub.setName("entfernen").setDescription("Fahrzeug aus der Liste entfernen.")
      .addStringOption(o => o.setName("funkrufname").setDescription("Funkrufname des Fahrzeugs").setRequired(true).setAutocomplete(true)))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("probealarm")
    .setDescription("Löst sofort einen gekennzeichneten Probealarm aus.")
    .toJSON(),
  probeCommand,
  new SlashCommandBuilder()
    .setName("sprachkanal")
    .setDescription("Website-Sprachkanäle verwalten.")
    
    .addSubcommand(sub => sub
      .setName("erstellen")
      .setDescription("Einen neuen Website-Sprachkanal erstellen.")
      .addStringOption(o => o.setName("name").setDescription("Name des neuen Kanals").setRequired(true).setMinLength(2).setMaxLength(90)))
    .toJSON()
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
  await loadVehicles();
  await ensureDefaultVoiceChannels().catch(error => console.error("[VOICE CHANNELS]", error));
  setInterval(checkScheduledProbe, 15000);
});

client.on("interactionCreate", async interaction => {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "funkrufname" || focused.name.startsWith("fahrzeug")) {
      const search = String(focused.value || "").toLowerCase();
      const matches = vehicles.filter(v => (v.funkrufname + " " + v.name).toLowerCase().includes(search)).slice(0, 25);
      return interaction.respond(matches.map(v => ({ name: (v.funkrufname + " – " + v.name).slice(0, 100), value: v.funkrufname }))).catch(() => {});
    }
    return interaction.respond([]).catch(() => {});
  }
  if (!interaction.isChatInputCommand()) return;
  if (!["alarm", "probealarm", "probe", "sprachkanal", "auto"].includes(interaction.commandName)) return;
  if (interaction.commandName === "auto") {
    let hasAutoAdminRole = interaction.member?.roles?.cache?.has(AUTO_ADMIN_ROLE_ID);
    if (!hasAutoAdminRole) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        hasAutoAdminRole = member.roles.cache.has(AUTO_ADMIN_ROLE_ID);
      } catch (error) { console.error("[AUTO ROLE CHECK]", error.message); }
    }
    if (!hasAutoAdminRole) return interaction.reply({ content: "❌ Nur Mitglieder mit der Admin-Rolle dürfen /auto verwenden.", ephemeral: true });
  } else {
    const hasCommandRole = await memberHasCommandRole(interaction);
    if (!hasCommandRole) return interaction.reply({ content: "❌ Du benötigst die freigeschaltete Rolle, um diesen Befehl zu benutzen.", ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    if (interaction.commandName === "auto") {
      const sub = interaction.options.getSubcommand();
      if (sub === "erstellen") {
        const funkrufname = clean(interaction.options.getString("funkrufname"), 80);
        const name = clean(interaction.options.getString("name"), 80);
        if (vehicles.some(v => v.funkrufname.toLowerCase() === funkrufname.toLowerCase())) return interaction.editReply("❌ Dieser Funkrufname ist bereits vergeben.");
        vehicles.push({ funkrufname, name });
        await saveVehicles();
        return interaction.editReply("✅ Fahrzeug gespeichert: **" + funkrufname + " – " + name + "**.");
      }
      if (sub === "liste") {
        return interaction.editReply(vehicles.length ? "**Fahrzeugbestand:**\n" + vehicles.map(v => "• **" + v.funkrufname + "** – " + v.name).join("\n") : "Noch keine Fahrzeuge angelegt. Nutze /auto erstellen.");
      }
      const funkrufname = interaction.options.getString("funkrufname");
      const before = vehicles.length;
      vehicles = vehicles.filter(v => v.funkrufname !== funkrufname);
      if (vehicles.length === before) return interaction.editReply("❌ Fahrzeug nicht gefunden.");
      await saveVehicles();
      return interaction.editReply("✅ Fahrzeug **" + funkrufname + "** wurde entfernt.");
    }
    if (interaction.commandName === "sprachkanal") {
      const name = clean(interaction.options.getString("name"), 90);
      const guild = await client.guilds.fetch(GUILD_ID);
      const channel = await createWebsiteVoiceChannel(guild, name);
      return interaction.editReply("✅ Website-Sprachkanal **" + channel.name + "** wurde erstellt. Aktualisiere die Website – der Kanal erscheint dann in der Liste.");
    }
    if (interaction.commandName === "alarm") {
      await queueAlarm({
        stichwort: interaction.options.getString("stichwort"),
        adresse: interaction.options.getString("adresse"),
        plz: interaction.options.getString("plz"),
        meldebild: interaction.options.getString("meldebild"),
        fahrzeuge: ["fahrzeug1", "fahrzeug2", "fahrzeug3", "fahrzeug4", "fahrzeug5"]
          .map(key => interaction.options.getString(key))
          .filter(Boolean)
          .map(funk => vehicles.find(v => v.funkrufname === funk))
          .filter(Boolean)
          .map(v => ({ funkrufname: v.funkrufname, name: v.name }))
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
