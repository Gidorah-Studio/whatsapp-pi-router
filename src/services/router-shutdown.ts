/**
 * Cancels routed turns while the socket is still open so senders can be told,
 * then closes the socket. A cleanup that hangs must not keep the socket open
 * past `graceMs`, and the caller must still not proceed until turns are stopped.
 */
export async function stopTurnsThenSocket(params: {
    stopTurns: () => Promise<void>;
    stopSocket: () => Promise<void>;
    graceMs: number;
}): Promise<void> {
    const turns = params.stopTurns();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>(resolve => { timer = setTimeout(resolve, params.graceMs); });
    await Promise.race([turns.then(() => undefined, () => undefined), grace]);
    clearTimeout(timer);
    try {
        await params.stopSocket();
    } finally {
        await turns;
    }
}
