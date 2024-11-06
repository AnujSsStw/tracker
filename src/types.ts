export interface Config {
  TELEGRAM_BOT_TOKEN: string;
  MAIN_CHAT_ID: string;
  COPY_WALLET_CHAT_ID: string;
  ETHERSCAN_API_KEY: string;
  ADDRESS: {
    DISPERSE: string;
    COINTOOL: string;
    MULTISENDER: string;
  };
  INITIAL_DAYS_TO_MONITOR: number;
  POLLING_INTERVAL: number;
}

export interface EtherscanTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasPrice: string;
  methodId: string;
  input: string;
  gasUsed: string;
}

export interface EtherscanTxInternal {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  input: string;
  type: string;
  gas: string;
  gasUsed: string;
  traceId: string;
  isError: string;
  errCode: string;
}
