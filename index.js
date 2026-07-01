const crypto = require("crypto");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const Redis = require("ioredis");

const app = express();
app.use(cors());
app.use(express.json());

const {
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_URL,
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

const livekitHost = LIVEKIT_URL || "https://stream-director-13gpu9p5.livekit.cloud";
const roomService = new RoomServiceClient(livekitHost, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// --- Helpers sala ---
async function getRoom(roomId) {
  const data = await redis.get("room:" + roomId);
  return data ? JSON.parse(data) : null;
}

async function setRoom(roomId, room) {
  await redis.set("room:" + roomId, JSON.stringify(room), "EX", 86400);
}

// --- Helpers cola ---
async function getQueue(roomId) {
  const data = await redis.get("queue:" + roomId);
  return data ? JSON.parse(data) : [];
}

async function setQueue(roomId, queue) {
  await redis.set("queue:" + roomId, JSON.stringify(queue), "EX", 86400);
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

    const identity = "streamer_" + participantName.trim().toLowerCase().replace(/\s+/g, "_");
    const name = participantName.trim();

    // Expulsar sesion previa si existe
    try {
      await roomService.removeParticipant(roomId, identity);
      console.log("Sesion previa de " + identity + " eliminada de sala " + roomId);
    } catch (e) {
      // Normal si no habia sesion previa
    }

    // Gestionar cola: si ya estaba, conservar su posicion original (joinedAt)
    const queue = await getQueue(roomId);
    const existing = queue.find(p => p.identity === identity);
    if (existing) {
      // Actualizar nombre por si cambio, conservar joinedAt original
      existing.name = name;
      existing.reconnectedAt = new Date().toISOString();
    } else {
      // Nueva entrada al final de la cola
      queue.push({ identity, name, joinedAt: new Date().toISOString() });
    }
    await setQueue(roomId, queue);

    const jwt = await makeToken(identity, name, {
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: false,
      canPublishData: true,
    });
    res.json({ token: jwt, identity });
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
      "operator_" + Date.now(),
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
      "screen_" + Date.now(),
      "Pantalla",
      { roomJoin: true, room: roomId, canPublish: false, canSubscribe: true, canPublishData: false }
    );
    res.json({ token: jwt });
  } catch (err) {
    console.error("Error token screen:", err);
    res.status(500).json({ error: "Error al generar token" });
  }
});

// Obtener cola ordenada por llegada
app.get("/api/rooms/:roomId/queue", async (req, res) => {
  try {
    const queue = await getQueue(req.params.roomId);
    res.json({ queue });
  } catch (err) {
    console.error("Error al obtener cola:", err);
    res.status(500).json({ error: "Error al obtener cola" });
  }
});

// Remover un participante de la cola (cuando se desconecta)
app.post("/api/rooms/:roomId/queue/remove", async (req, res) => {
  try {
    const { identity } = req.body;
    if (!identity) return res.status(400).json({ error: "Falta identity" });
    const queue = await getQueue(req.params.roomId);
    const updated = queue.filter(p => p.identity !== identity);
    await setQueue(req.params.roomId, updated);
    res.json({ ok: true, queue: updated });
  } catch (err) {
    console.error("Error al remover de cola:", err);
    res.status(500).json({ error: "Error al remover de cola" });
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
    res.json({ selected: room.selectedParticipant, closed: room.closed || false });
  } catch (err) {
    console.error("Error al obtener seleccion:", err);
    res.status(500).json({ error: "Error al obtener seleccion" });
  }
});

app.post("/api/rooms/:roomId/close", async (req, res) => {
  try {
    const { roomId } = req.params;
    const key = "room:" + roomId.toUpperCase();
    const raw = await redis.get(key);
    if (!raw) return res.status(404).json({ error: "Sala no encontrada" });
    const room = JSON.parse(raw);
    room.closed = true;
    await redis.set(key, JSON.stringify(room));
    // Limpiar cola tambien
    await redis.del("queue:" + roomId.toUpperCase());
    setTimeout(async () => { try { await redis.del(key); } catch (e) {} }, 30000);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al cerrar sala:", err);
    res.status(500).json({ error: "Error al cerrar sala" });
  }
});

app.post("/api/auth/operator", (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ ok: false });
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const stored = process.env.OPERATOR_PASSWORD_HASH;
    if (!stored) return res.status(500).json({ ok: false, error: "No configurado" });
    if (hash.length !== stored.length) return res.json({ ok: false });
    const ok = crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(stored, "hex"));
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => console.log("Backend corriendo en puerto " + PORT));
