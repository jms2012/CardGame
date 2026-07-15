const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// Socket.io 跨域配置，兼容代理访问
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
    transports: ["websocket", "polling"]
  },
  allowEIO3: true
});

// 静态文件服务（本地测试用，部署后前端走Vercel不影响）
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// 等待匹配的玩家
let waitingPlayer = null;
// 房间数据
const rooms = new Map();

// 创建一副简单数字牌
function createDeck() {
  const deck = [];
  for (let i = 1; i <= 20; i++) deck.push(i);
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawCard(room) {
  if (room.deck.length === 0) return null;
  return room.deck.pop();
}

function getOpponent(room, socketId) {
  return room.players.find((p) => p.id !== socketId);
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("set-name", (name) => {
    socket.data.name = name || "匿名玩家";
    socket.emit("system-message", `你好，${socket.data.name}！`);

    // 自动匹配
    if (!waitingPlayer) {
      waitingPlayer = socket;
      socket.emit("system-message", "正在等待对手匹配...");
    } else {
      const roomId = `room_${waitingPlayer.id}_${socket.id}`;
      const room = {
        id: roomId,
        deck: createDeck(),
        players: [
          { id: waitingPlayer.id, name: waitingPlayer.data.name, hand: [] },
          { id: socket.id, name: socket.data.name, hand: [] },
        ],
        turn: waitingPlayer.id,
        started: true,
      };
      rooms.set(roomId, room);

      waitingPlayer.join(roomId);
      socket.join(roomId);

      // 初始发牌
      for (let i = 0; i < 3; i++) {
        room.players[0].hand.push(drawCard(room));
        room.players[1].hand.push(drawCard(room));
      }

      io.to(roomId).emit("game-start", {
        roomId,
        players: room.players,
        turn: room.turn,
        deckCount: room.deck.length,
      });
      waitingPlayer.emit("system-message", "已匹配到对手，游戏开始！");
      socket.emit("system-message", "已匹配到对手，游戏开始！");
      waitingPlayer = null;
    }
  });

  socket.on("draw-card", (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.turn !== socket.id) {
      socket.emit("system-message", "还没轮到你。");
      return;
    }
    const player = room.players.find((p) => p.id === socket.id);
    const card = drawCard(room);
    if (!card) {
      socket.emit("system-message", "牌库已经没有牌了。");
      return;
    }
    player.hand.push(card);
    io.to(roomId).emit("game-update", {
      players: room.players,
      turn: room.turn,
      deckCount: room.deck.length,
      message: `${player.name} 抽了一张牌。`,
    });
  });

  socket.on("play-card", ({ roomId, card }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.turn !== socket.id) {
      socket.emit("system-message", "还没轮到你。");
      return;
    }
    const player = room.players.find((p) => p.id === socket.id);
    const index = player.hand.indexOf(card);
    if (index === -1) {
      socket.emit("system-message", "你没有这张牌。");
      return;
    }
    player.hand.splice(index, 1);
    // 出牌后轮到对手
    const opponent = getOpponent(room, socket.id);
    room.turn = opponent.id;
    io.to(roomId).emit("game-update", {
      players: room.players,
      turn: room.turn,
      deckCount: room.deck.length,
      message: `${player.name} 打出了 ${card}。轮到 ${opponent.name}。`,
    });
  });

  socket.on("chat", ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    io.to(roomId).emit("chat", {
      name: player?.name || "匿名",
      message,
    });
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    // 清理房间
    for (const [roomId, room] of rooms.entries()) {
      const hasPlayer = room.players.some((p) => p.id === socket.id);
      if (hasPlayer) {
        io.to(roomId).emit("system-message", "对手已断开连接，游戏结束。");
        rooms.delete(roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
