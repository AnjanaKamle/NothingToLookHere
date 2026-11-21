import "dotenv/config";
import { app } from "./app.js";
import { prisma } from "./db.js";

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32
  || process.env.JWT_SECRET.startsWith("replace-this")) {
  throw new Error("Set DATABASE_URL and replace the JWT_SECRET placeholder with a random value of at least 32 characters");
}

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => console.info(`sem3 Capstone is running at http://localhost:${port}`));

async function stop() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
