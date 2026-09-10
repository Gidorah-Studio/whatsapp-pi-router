import { RouterError } from './router-errors.js';

type Job = {
    key: string;
    task: (signal: AbortSignal) => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
};

/** FIFO within each conversation, with a bounded global worker pool. */
export class ConversationScheduler {
    private readonly waiting: Job[] = [];
    private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
    private stopped = false;
    constructor(private readonly concurrency = 4, private readonly perConversation = 10, private readonly capacity = 100) {
        if (![concurrency, perConversation, capacity].every(value => Number.isSafeInteger(value) && value > 0)) {
            throw new Error('Scheduler limits must be positive integers');
        }
    }
    enqueue<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.stopped) return Promise.reject(new RouterError('stopped'));
        const count = this.waiting.filter(job => job.key === key).length + Number(this.active.has(key));
        if (count >= this.perConversation || this.waiting.length + this.active.size >= this.capacity) {
            return Promise.reject(new RouterError('busy'));
        }
        return new Promise<T>((resolve, reject) => {
            this.waiting.push({ key, task, resolve: resolve as (value: unknown) => void, reject });
            this.pump();
        });
    }
    private pump(): void {
        while (!this.stopped && this.active.size < this.concurrency) {
            const index = this.waiting.findIndex(job => !this.active.has(job.key));
            if (index < 0) break;
            const job = this.waiting.splice(index, 1)[0];
            const controller = new AbortController();
            const done = Promise.resolve().then(() => job.task(controller.signal))
                .then(job.resolve, job.reject).finally(() => {
                    this.active.delete(job.key);
                    this.pump();
                });
            this.active.set(job.key, { controller, done });
        }
    }
    async stop(): Promise<void> {
        this.stopped = true;
        for (const job of this.waiting.splice(0)) job.reject(new RouterError('stopped'));
        const active = [...this.active.values()];
        for (const job of active) job.controller.abort();
        await Promise.all(active.map(job => job.done));
    }
}
