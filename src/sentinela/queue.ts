import { Queue } from 'bullmq';
import { redisOptions } from '../lib/redis.js';

export const sentinelQueue = new Queue('sentinela', {
  connection: redisOptions(),
  defaultJobOptions: { removeOnComplete: 500, removeOnFail: 2000 },
});
