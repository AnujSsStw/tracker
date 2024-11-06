import { sleep } from "bun";
import TelegramBot from "node-telegram-bot-api";
import { EtherscanAPI } from "./src/ether-scan";
import type { Config } from "./src/types";

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

api.getInternalTransactions(config.ADDRESS.DISPERSE, 21121982).then((txs) => {
  txs.forEach((tx) => {
    console.log(tx);
  });
});
