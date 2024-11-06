import axios from "axios";
import { logger } from "./logger";
import type { EtherscanTx, EtherscanTxInternal } from "./types";
import { Alchemy, Network } from "alchemy-sdk";

export class EtherscanAPI {
  private readonly baseURL = "https://api.etherscan.io/api";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getContractTransactions(
    address: string,
    startBlock: number
  ): Promise<EtherscanTx[]> {
    try {
      const response = await axios.get(this.baseURL, {
        params: {
          module: "account",
          action: "txlist",
          address,
          startblock: startBlock,
          endblock: "latest",
          sort: "asc",
          apikey: this.apiKey,
        },
      });

      if (response.data.status === "1" && response.data.result) {
        return response.data.result;
      }
      return [];
    } catch (error) {
      logger.error("Etherscan API error:", error);
      throw error;
    }
  }

  async getInternalTransactions(
    address: string,
    block: number
  ): Promise<EtherscanTxInternal[]> {
    try {
      const response = await axios.get(this.baseURL, {
        params: {
          module: "account",
          action: "txlistinternal",
          address,
          startblock: block,
          sort: "asc",
          apikey: this.apiKey,
        },
      });

      if (response.data.status === "1" && response.data.result) {
        console.log(response.data.result.length, "block");

        return response.data.result;
      }
      return [];
    } catch (error) {
      logger.error("Etherscan API error:", error);
      throw error;
    }
  }

  async getLatestBlock(): Promise<number | null> {
    try {
      const response = await axios.get(this.baseURL, {
        params: {
          module: "proxy",
          action: "eth_blockNumber",
          apikey: this.apiKey,
        },
      });

      const blockNumber = parseInt(response.data.result, 16);
      return blockNumber;
    } catch (error: any) {
      logger.error("Error getting latest block:", error.message);
      return null;
    }
  }
}

const config = {
  apiKey: process.env.ALCHEMEY_API_KEY!,
  network: Network.ETH_MAINNET,
};
export const alchemy = new Alchemy(config);
