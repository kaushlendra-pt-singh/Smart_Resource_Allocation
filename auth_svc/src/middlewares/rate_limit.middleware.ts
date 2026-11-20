import rateLimit from "express-rate-limit";

// Per-IP limit for public routes. Internal service-to-service routes do NOT use this limiter.
// In development every service sees 127.0.0.1, so the default is generous there.
const isProd = process.env.NODE_ENV === "production";

export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_MAX) || (isProd ? 100 : 1000),
  message: { message: "Too many requests from this IP, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
