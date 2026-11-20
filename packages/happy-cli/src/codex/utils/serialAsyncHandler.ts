export function createSerialAsyncHandler<T>(
    handler: (value: T) => Promise<void>,
    onError?: (error: unknown) => void,
) {
    let tail = Promise.resolve();

    let pending = 0;
    const accept = (value: T) => {
        pending++;
        tail = tail
            .then(() => handler(value))
            .catch((error) => {
                onError?.(error);
            }).finally(() => { pending--; });
    };
    return Object.assign(accept, { busy: () => pending > 0 });
}
