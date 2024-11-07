import { sleep } from "bun";
import TelegramBot from "node-telegram-bot-api";
import { alchemy, EtherscanAPI } from "./src/ether-scan";
import type { Config } from "./src/types";
import { AssetTransfersCategory } from "alchemy-sdk";

const config: Config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  MAIN_CHAT_ID: process.env.MAIN_CHAT_ID!,
  COPY_WALLET_CHAT_ID: process.env.COPY_WALLET_CHAT_ID!,
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY!,
  ADDRESS: {
    DISPERSE: "0xD152f549545093347A162Dce210e7293f1452150",
    COINTOOL: "0xCEC8F07014d889442D7Cf3b477b8F72f8179eA09",
    MULTISENDER: "0x88888c037DF4527933fa8Ab203a89e1e6E58db70",
  },

  INITIAL_DAYS_TO_MONITOR: 1,
  POLLING_INTERVAL: 15, // in seconds
};

const api = new EtherscanAPI(config.ETHERSCAN_API_KEY);
// api
//   .getContractTransactions(
//     "0xCEC8F07014d889442D7Cf3b477b8F72f8179eA09",
//     21126973
//   )
//   .then((txs) => {
//     txs.forEach((tx) => {
//       console.log(tx.from);
//       console.log(tx.functionName);
//     });
//   });

// api.getInternalTransactions(config.ADDRESS.DISPERSE, 21121982).then((txs) => {
//   txs.forEach((tx) => {
//     console.log(tx);
//   });
// });

async function checkOldTransactions(
  wallets: string[],
  address: string
): Promise<boolean> {
  try {
    // Use the Alchemy API to check if any of the wallets have had previous transactions
    // with the monitored addresses
    for (const wallet of wallets) {
      const transactions = await alchemy.core.getAssetTransfers({
        fromAddress: address,
        toAddress: wallet,
        excludeZeroValue: true,
        category: [AssetTransfersCategory.INTERNAL],
      });
      console.log(transactions);

      if (transactions.transfers.length > 1) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error("Error checking old transactions:", error);
    return false;
  }
}

// checkOldTransactions(
//   [
//     "0xbddf7bdd935fc69b1e8bc055cc1de9107ff452e9",
//     "0x00000000000030e5959659622cb7eb50aa20ee52",
//   ],
//   config.ADDRESS.DISPERSE
// ).then((result) => {
//   console.log(result);
// });

// const res = await fetch(
//   `https://api.etherscan.io/api?module=account&action=txlisttxlistinternal&address=${config.ADDRESS.DISPERSE}&startblock=0&endblock=99999999&sort=asc&apikey=${config.ETHERSCAN_API_KEY}`
// );
// const data = await res.json();
// console.log(data);
