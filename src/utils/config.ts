export const config = {
    liquidity_pool: {
      ignore_pump_fun: true,
      raydium_program_id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      wsol_pc_mint: "So111111111111111111111111111111111111112",
    },
    tx: {
      get_retry_interval: 750,
      get_retry_timeout: 20000,
    },
    swap: {
      amount: "10000000", //0.01 SOL
      slippageBps: "200", // 2%
    },
    rug_check: {
      single_holder_ownership: 30,
      not_allowed: ["Freeze Authority still enabled", "Large Amount of LP Unlocked", "Copycat token"],
    },
  };