import { Queue } from 'bullmq';
import { redisOptions } from '../lib/redis.js';

export const sentinelQueue = new Queue('sentinela', {
  connection: redisOptions(),
  defaultJobOptions: { removeOnComplete: { count: 200, age: 86_400 }, removeOnFail: { count: 300, age: 7 * 86_400 } },
});
