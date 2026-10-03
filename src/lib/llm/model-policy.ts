/** Provider connections retain their IDs/routes; only model connections can power ordinary chats. */
export const isChatModel = (app: { provider: string }) => app.provider !== "hermes";

export const HERMES_BOT_ONLY_MESSAGE = "Hermes is an agent backend for bots. Choose or create a bot using this connection to start a new chat. Existing history stays available; its session is not transferred.";
