export const RedisKeys = {
    userByEmail: (email: string) => `user:email:${email.toLowerCase()}`,
    userProfile: (userId: string) => `user:${userId}:profile`,
    userRefreshToken: (userId: string) => `user:${userId}:refresh_token`,
    passwordResetToken: (hashedToken: string) => `auth:reset:${hashedToken}`
};