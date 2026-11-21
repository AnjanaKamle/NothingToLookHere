import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/services/passwords.js";

const prisma = new PrismaClient();

try {
  const phone = process.argv[2];
  const password = process.argv[3];
  if (!phone || !password) {
    throw new Error("Usage: npm run db:seed -- <phone> <password>");
  }
  const user = await prisma.user.upsert({
    where: { phone },
    update: { passwordHash: await hashPassword(password) },
    create: { phone, passwordHash: await hashPassword(password) }
  });
  console.log(`Created or updated demo user ${user.phone}`);
} finally {
  await prisma.$disconnect();
}
