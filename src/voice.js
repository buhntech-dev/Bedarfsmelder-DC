const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType
} = require("@discordjs/voice");
const googleTTS = require("google-tts-api");

const ffmpegPath = require("ffmpeg-static");
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

const localAlarm = path.join(__dirname, "..", "assets", "alarm.mp3");

async function getAudioBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Audiodatei konnte nicht geladen werden: HTTP " + response.status);
  return Buffer.from(await response.arrayBuffer());
}
async function createSpeechFile(text) {
  const chunks = googleTTS.getAllAudioUrls(text, { lang: "de", slow: false, host: "https://translate.google.com" });
  const buffers = [];
  for (const chunk of chunks) buffers.push(await getAudioBuffer(chunk.url));
  const file = path.join(os.tmpdir(), "bedarfsmelder-tts-" + Date.now() + ".mp3");
  fs.writeFileSync(file, Buffer.concat(buffers));
  return file;
}
function waitForPlayback(player) {
  return new Promise((resolve, reject) => {
    const onIdle = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off("error", onError);
    };
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
  });
}
async function playFile(player, file) {
  const resource = createAudioResource(file, { inputType: StreamType.Arbitrary });
  const done = waitForPlayback(player);
  player.play(resource);
  await done;
}
async function playUrl(player, url) {
  const buffer = await getAudioBuffer(url);
  const stream = Readable.from(buffer);
  const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
  const done = waitForPlayback(player);
  player.play(resource);
  await done;
}

async function playAlarmSequenceInChannel(client, { guildId, channelId, announcement, audioUrl }) {
  if (!guildId || !channelId) throw new Error("DISCORD_GUILD_ID oder VOICE_CHANNEL_ID fehlt.");
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) throw new Error("Der konfigurierte Discord-Kanal ist kein Sprachkanal.");
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  const player = createAudioPlayer();
  connection.subscribe(player);
  try {
    const alarmPath = audioUrl ? null : (fs.existsSync(localAlarm) ? localAlarm : null);
    if (audioUrl) {
      console.log("[VOICE] Spiele Alarmton von URL vollständig ab.");
      await playUrl(player, audioUrl);
    } else if (alarmPath) {
      console.log("[VOICE] Spiele assets/alarm.mp3 vollständig ab.");
      await playFile(player, alarmPath);
    } else {
      console.warn("[VOICE] Keine Alarmdatei gefunden – Sprachdurchsage startet ohne Ton.");
    }
    const speechFile = await createSpeechFile(announcement);
    try {
      console.log("[VOICE] Sprachdurchsage startet.");
      await playFile(player, speechFile);
    } finally {
      try { fs.unlinkSync(speechFile); } catch {}
    }
    console.log("[VOICE] Alarmablauf abgeschlossen.");
  } finally {
    player.stop(true);
    connection.destroy();
  }
}
async function playAlarmSequence(client, options) {
  const channelIds = [...new Set((options.channelIds || [options.channelId]).filter(Boolean))];
  if (!channelIds.length) throw new Error("Keine Sprachkanäle konfiguriert.");
  const results = await Promise.allSettled(channelIds.map(channelId =>
    playAlarmSequenceInChannel(client, { ...options, channelId })
  ));
  const failed = results.map((result, index) => ({ result, channelId: channelIds[index] }))
    .filter(item => item.result.status === "rejected");
  if (failed.length) {
    const details = failed.map(item => item.channelId + ": " + item.result.reason.message).join("; ");
    throw new Error("Nicht alle Sprachkanäle konnten die Meldung abspielen: " + details);
  }
}
module.exports = { playAlarmSequence };
