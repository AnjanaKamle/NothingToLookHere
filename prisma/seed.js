import { prisma } from "../src/db.js";
import { hashPassword } from "../src/services/passwords.js";

try {
  const phone = process.argv[2];
  const password = process.argv[3];
  if (!phone || !password) {
    throw new Error("Usage: npm run db:seed -- <phone> <password>");
  }
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { phone },
    update: { passwordHash },
    create: { phone, passwordHash }
  });
  console.log(`Created or updated demo user ${user.phone}`);
} finally {
  await prisma.$disconnect();
}
