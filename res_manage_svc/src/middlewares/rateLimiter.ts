import rateLimit from "express-rate-limit";

const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 registration requests per window
  message: { message: "Too many requests from this IP, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

export default rateLimiter;