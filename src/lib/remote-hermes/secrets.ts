/** Bind personal dashboard credentials to both their connection and owner. */
export const remoteConnectionAAD = (id: string, owner: string) => `remote_hermes_connections.secret_enc|${id}|${owner}`;
