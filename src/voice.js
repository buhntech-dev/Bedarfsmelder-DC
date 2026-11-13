const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const googleTTS = require("google-tts-api");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType
} = require("@discordjs/voice");

const ffmpegPath = require("ffmpeg-static");
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;
const localAlarm = path.join(__dirname, "..", "assets", "alarm.mp3");

async function getAudioBuffer(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Audiodatei konnte nicht geladen werden: HTTP " + response.status);
  return Buffer.from(await response.arrayBuffer());
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
async function playResource(player, resource) {
  const done = waitForPlayback(player);
  player.play(resource);
  await done;
}
async function playAlarmSequenceInChannel(client, { guildId, channelId, audioUrl }) {
  if (!guildId || !channelId) throw new Error("DISCORD_GUILD_ID oder Sprachkanal-ID fehlt.");
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) throw new Error("Kanal " + channelId + " ist kein Sprachkanal.");
  const me = await guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has("Connect") || !permissions?.has("Speak")) {
    throw new Error("Dem Bot fehlen im Sprachkanal " + channelId + " die Rechte 'Kanal ansehen', 'Verbinden' oder 'Sprechen'.");
  }

  console.log("[VOICE CHECK] Kanal=" + channel.name + " (" + channel.id + "), Guild=" + guild.id
    + ", Connect=" + Boolean(permissions?.has("Connect")) + ", Speak=" + Boolean(permissions?.has("Speak"))
    + ", ViewChannel=" + Boolean(permissions?.has("ViewChannel")));
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  connection.on("stateChange", (oldState, newState) => {
    console.log("[VOICE STATE] " + channelId + ": " + oldState.status + " -> " + newState.status);
  });
  connection.on("debug", message => console.log("[VOICE DEBUG] " + channelId + ": " + message));
  connection.on("error", error => console.error("[VOICE CONNECTION ERROR] " + channelId, error));
  try {
    console.log("[VOICE] Verbinde mit " + channelId + " …");
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    console.log("[VOICE] Verbunden mit " + channelId);
    const alarmPath = audioUrl ? null : (fs.existsSync(localAlarm) ? localAlarm : null);
    if (audioUrl) {
      await playResource(player, createAudioResource(Readable.from(await getAudioBuffer(audioUrl)), { inputType: StreamType.Arbitrary }));
    } else if (alarmPath) {
      await playResource(player, createAudioResource(alarmPath, { inputType: StreamType.Arbitrary }));
    } else {
      throw new Error("Die Audiodatei fehlt. Bitte assets/alarm.mp3 in das GitHub-Repository hochladen oder ALARM_AUDIO_URL setzen.");
    }
    console.log("[VOICE] Alarmton vollständig abgespielt. Starte deutsche KI-Sprachdurchsage …");
    if (announcement && String(announcement).trim()) {
      const chunks = googleTTS.getAllAudioUrls(String(announcement).slice(0, 1800), {
        lang: "de", slow: false, host: "https://translate.google.com"
      });
      for (const chunk of chunks) {
        const speechBuffer = await getAudioBuffer(chunk.url);
        await playResource(player, createAudioResource(Readable.from(speechBuffer), { inputType: StreamType.Arbitrary }));
      }
      console.log("[VOICE] Deutsche Sprachdurchsage vollständig abgespielt.");
    }
  } finally {
    player.stop(true);
    connection.destroy();
  }
}

// Ein Discord-Bot kann pro Server nur in EINEM Sprachkanal gleichzeitig sein.
// Deshalb werden mehrere konfigurierte Kanäle nacheinander bedient, nicht parallel.
async function playAlarmSequence(client, options) {
  const channelIds = [...new Set((options.channelIds || [options.channelId]).filter(Boolean))];
  if (!channelIds.length) throw new Error("Keine Sprachkanäle konfiguriert.");
  const failures = [];
  for (const channelId of channelIds) {
    try {
      await playAlarmSequenceInChannel(client, { ...options, channelId });
    } catch (error) {
      console.error("[VOICE ERROR] " + channelId, error);
      failures.push(channelId + ": " + (error?.message || String(error)));
    }
  }
  if (failures.length) throw new Error("Sprachwiedergabe fehlgeschlagen: " + failures.join("; "));
}
module.exports = { playAlarmSequence };
