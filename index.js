require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { AccessToken } = require("livekit-server-sdk");
const Redis = require("ioredis");

const app = express();
app.use(cors());
app.use(express.json());

const {
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  PORT = 3000,
  REDIS_URL,
} = process.env;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("ERROR: Faltan LIVEKIT_API_KEY o LIVEKIT_API_SECRET");
  process.exit(1);
}

if (!REDIS_URL) {
  console.error("ERROR: Falta REDIS_URL");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  tls: REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

redis.on("connect", () => console.log("Redis conectado"));
redis.on("error", (err) => console.error("Redis error:", err.message));

async function getRoom(roomId) {
  const data = await redis.get(`room:${roomId}`);
  return data ? JSON.parse(data) : null;
}

async function setRoom(roomId, room) {
  await redis.set(`room:${roomId}`, JSON.stringify(room), "EX", 86400);
}

async function makeToken(identity, name, grants) {
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name });
  token.addGrant(grants);
  return await token.toJwt();
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/api/rooms", async (req, res) => {
  try {
    const { name, roomId: customRoomId } = req.body;
    const roomId = (customRoomId || '').trim().toUpperCase() || uuidv4().slice(0, 8).toUpperCase();
    const room = { id: roomId, name: name || "Evento", createdAt: new Date().toISOString(), selectedParticipant: null };
    await setRoom(roomId, room);
    res.json({ roomId, room });
  } catch (err) {
    console.error("Error al crear sala:", err);
    res.status(500).json({ error: "Error al crear sala" });
  }
});

app.get("/api/rooms/:roomId", async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: "Sala no encontrada" });
    res.json(room);
  } catch (err) {
    console.error("Error al obtener sala:", err);
    res.status(500).json({ error: "Error al obtener sala" });
  }
});

app.post("/api/token/streamer", async (req, res) => {
  try {
    const { roomId, participantName } = req.body;
    if (!roomId || !participantName) return res.status(400).json({ error: "Faltan roomId o participantName" });
    const jwt = await makeToken(
      `streamer_${participantName}_${Date.now()}`,
      participantName,
      { roomJoin: true, room: roomId, canPublish: true, canSubscribe: false, canPublishData: true }
    );
    res.json({ token: jwt });
  } catch (err) {
    console.error("Error token streamer:", err);
    res.status(500).json({ error: "Error al generar token" });
  }
});

app.post("/api/token/operator", async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: "Falta roomId" });
    const jwt = await makeToken(
      `operator_${Date.now()}`,
      "Operador",
      { roomJoin: true, room: roomId, canPublish: false, canSubscribe: true, canPublishData: true, roomAdmin: true }
    );
    res.json({ token: jwt });
  } catch (err) {
    console.error("Error token operator:", err);
    res.status(500).json({ error: "Error al generar token" });
  }
});

app.post("/api/token/screen", async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: "Falta roomId" });
    const jwt = await makeToken(
      `screen_${Date.now()}`,
      "Pantalla",
      { roomJoin: true, room: roomId, canPublish: false, canSubscribe: true, canPublishData: false }
    );
    res.json({ token: jwt });
  } catch (err) {
    console.error("Error token screen:", err);
    res.status(500).json({ error: "Error al generar token" });
  }
});

app.post("/api/rooms/:roomId/select", async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: "Sala no encontrada" });
    room.selectedParticipant = req.body.participantIdentity || null;
    await setRoom(req.params.roomId, room);
    res.json({ ok: true, selected: room.selectedParticipant });
  } catch (err) {
    console.error("Error al seleccionar:", err);
    res.status(500).json({ error: "Error al seleccionar participante" });
  }
});

app.get("/api/rooms/:roomId/selected", async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: "Sala no encontrada" });
    res.json({ selected: room.selectedParticipant });
  } catch (err) {
    console.error("Error al obtener seleccion:", err);
    res.status(500).json({ error: "Error al obtener seleccion" });
  }
});

app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));
