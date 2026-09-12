import { createClient } from "redis";

export const redisConnectionOptions = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
};

export const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
    socket: {
        reconnectStrategy: (retries: number) => {
            // Stop reconnecting after 10 failed attempts
            if (retries > 10) {
                console.error("❌ Redis max reconnect attempts reached. Operating in DB-only mode.");
                return new Error("Redis connection failed permanently.");
            }
            // Exponential backoff: delay = retries * 500ms (max 3000ms delay between retries)
            return Math.min(retries * 500, 3000);
        }
    }
});

redisClient.on("error", (err) => console.error("❌ Redis Client Error:", err));
redisClient.on("connect", () => console.log("⚡ Redis Client Connected Successfully"));

export const connectRedis = async () => {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
    } catch (error) {
        console.error("Failed to connect to Redis:", error);
    }
};

export const safeRedis = {
    get: async (key: string): Promise<string | null> => {
        try {
            if (!redisClient.isOpen) return null;
            return await redisClient.get(key);
        } catch (err) {
            console.warn(`Redis GET failed for key: ${key}`);
            return null;
        }
    },

    set: async (key: string, value: string, options?: any): Promise<string | null> => {
        try {
            if (!redisClient.isOpen) return null;
            return await redisClient.set(key, value, options);
        } catch (err) {
            console.warn(`Redis SET failed for key: ${key}`);
            return null;
        }
    },

    del: async (keys: string | string[]): Promise<number> => {
        try {
            if (!redisClient.isOpen || (Array.isArray(keys) && keys.length === 0)) return 0;
            return await redisClient.del(keys);
        } catch (err) {
            console.warn(`Redis DEL failed for keys: ${keys}`);
            return 0;
        }
    },

    exists: async (key: string): Promise<number> => {
        try {
            if (!redisClient.isOpen) return 0;
            return await redisClient.exists(key);
        } catch (err) {
            console.warn(`Redis EXISTS failed for key: ${key}`);
            return 0;
        }
    },

    expire: async (key: string, seconds: number): Promise<number> => {
        try {
            if (!redisClient.isOpen) return 0;
            return await redisClient.expire(key, seconds);
        } catch (err) {
            console.warn(`Redis EXPIRE failed for key: ${key}`);
            return 0;
        }
    },

    ttl: async (key: string): Promise<number> => {
        try {
            if (!redisClient.isOpen) return -2;
            return await redisClient.ttl(key);
        } catch (err) {
            console.warn(`Redis TTL failed for key: ${key}`);
            return -2;
        }
    },

    incr: async (key: string): Promise<number | null> => {
        try {
            if (!redisClient.isOpen) return null;
            return await redisClient.incr(key);
        } catch (err) {
            console.warn(`Redis INCR failed for key: ${key}`);
            return null;
        }
    },

    mGet: async (keys: string[]): Promise<(string | null)[]> => {
        try {
            if (!redisClient.isOpen || !keys.length) return new Array(keys.length).fill(null);
            return await redisClient.mGet(keys);
        } catch (err) {
            console.warn(`Redis MGET failed for keys: ${keys}`);
            return new Array(keys.length).fill(null);
        }
    },

    deletePattern: async (pattern: string): Promise<void> => {
        try {
            if (!redisClient.isOpen) return;
            const keys: string[] = [];
            for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
                if (typeof key === "string") keys.push(key);
                else if (Array.isArray(key)) keys.push(...key);
            }
            if (keys.length > 0) {
                await redisClient.del(keys);
            }
        } catch (err) {
            console.warn(`Redis deletePattern failed for pattern: ${pattern}`);
        }
    }
};