import { Database, PrismaClient } from "@prisma/client";
import prisma from "../db/prisma";
import { redis } from "../db/redis";
import { getCachedData } from "../lib/cacheData";
import { TRANSFER } from "../types/params";
import { getDatabaseClient } from "../utils/dbUtils";
import { ensureTransferTableExists, insertTransferData } from "../utils/tableUtils";

const HELIUS_API_URL = "https://api.helius.xyz/v0/webhooks";
const HELIUS_MAINNET_API_KEY = process.env.HELIUS_MAINNET_API_KEY;
const WEBHOOK_DEVNET_API_KEY = process.env.WEBHOOK_DEVNET_API_KEY;
const WEBHOOK_DEVNET_SECRET = process.env.WEBHOOK_DEVNET_SECRET;
const WEBHOOK_MAINNET_SECRET = process.env.WEBHOOK_MAINNET_SECRET;
const MAINNET_WEBHOOK_ID = process.env.MAINNET_WEBHOOK_ID;
const DEVNET_WEBHOOK_ID = process.env.DEVNET_WEBHOOK_ID;

export default async function processData(webhookData: any) {
  console.time("Total processData");

  const { accountData } = webhookData;
  if (!accountData) return;

  console.time("getCachedData");
  const { databases, settings, users } = await getCachedData();
  console.timeEnd("getCachedData");

  const accounts = new Set(accountData.map((acc: any) => acc.account));
  const dbMap = Object.fromEntries(databases.map((db: Database) => [db.id, db]));
  const userMap = Object.fromEntries(users.map((u: any) => [u.id, u]));

  console.time("settings loop");
  await Promise.allSettled(
    settings.map(async (s) => {
      if (!accounts.has(s.targetAddr)) return;

      try {
        const user = userMap[s.userId];
        if (!user) return;

        console.time(`updateUserCredits:${s.userId}`);
        const updatedUser = await updateUserCredits(user.id, s.databaseId);
        console.timeEnd(`updateUserCredits:${s.userId}`);

        if (!updatedUser || updatedUser.credits <= 100) {
          await handleLowCreditUser(s, updatedUser);
          return;
        }

        const dbConfig = dbMap[s.databaseId];
        if (!dbConfig) return;

        console.time(`getDatabaseClient:${s.databaseId}`);
        const db = await getDatabaseClient(dbConfig);
        console.timeEnd(`getDatabaseClient:${s.databaseId}`);

        console.time(`handleTransaction:${s.databaseId}`);
        await handleTransaction(db, TRANSFER, webhookData);
        console.timeEnd(`handleTransaction:${s.databaseId}`);
      } catch (err) {
        console.error(`Error processing settings for database ${s.databaseId}:`, err);
      }
    })
  );
  console.timeEnd("settings loop");

  console.timeEnd("Total processData");
}

async function handleLowCreditUser(s: any, user: any) {
  const webhookParams = await prisma.params.findFirst();
  const WEBHOOK_SECRET = s.cluster === "DEVNET" ? WEBHOOK_DEVNET_SECRET : WEBHOOK_MAINNET_SECRET;
  const WEBHOOK_ID = s.cluster === "DEVNET" ? DEVNET_WEBHOOK_ID : MAINNET_WEBHOOK_ID;
  const HELIUS_API_KEY = s.cluster === "DEVNET" ? WEBHOOK_DEVNET_API_KEY : HELIUS_MAINNET_API_KEY;

  const webhookBody = {
    transactionTypes: webhookParams?.transactionTypes,
    accountAddress: webhookParams?.accountAddresses.filter((addr: string) => addr !== s.targetAddr),
  };

  const res = await fetch(`${HELIUS_API_URL}/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`, {
    method: "PUT",
    headers: {
      "Authorization": `${WEBHOOK_SECRET}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(webhookBody),
  });

  if (!res.ok) return;

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { credits: 0 } }),
    prisma.params.update({
      where: { id: webhookParams?.id },
      data: {
        transactionTypes: webhookParams?.transactionTypes,
        accountAddresses: webhookParams?.accountAddresses.filter((addr: string) => addr !== s.targetAddr),
      },
    }),
  ]);

  clearRedisCache(s.databaseId);
}

async function handleTransaction(db: PrismaClient, type: string, data: any) {
  switch (type) {
    case TRANSFER:
      const { slot, signature, feePayer, fee, description, accountData, instructions } = data;

      if (!slot || !signature || !feePayer || !fee || !accountData || !instructions) {
        console.error("Missing required fields for TRANSFER job");
        return;
      }

      const tableName = TRANSFER;
      await ensureTransferTableExists(db, tableName);

      await insertTransferData(db, tableName, { slot, signature, feePayer, fee, description, accountData, instructions });
      break;
    default:
      break;
  }
}

async function updateUserCredits(userId: string | undefined, databaseId: string) {
  if (!userId) return null;

  let user = await prisma.user.findUnique({
    where: { id: userId },
    include: { databases: true },
  });

  if (user) {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { credits: user.credits - 1 },
      include: { databases: true },
    });

    await redis.set(`user:${databaseId}`, JSON.stringify(updatedUser));
    return updatedUser;
  } else {
    clearRedisCache(databaseId);
    console.error(`User not found for ID: ${userId}`);
    return null;
  }
}

function clearRedisCache(databaseId: string) {
  redis.del(`user:${databaseId}`);
  redis.del(`settings:${databaseId}`);
  redis.del(`database:${databaseId}`);
}