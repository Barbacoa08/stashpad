import { createAccountCheck } from '../../server/account-check';

export default (request: Request) =>
  createAccountCheck(
    process.env.SCRATCHTREE_ALLOWED_EMAILS === undefined
      ? []
      : process.env.SCRATCHTREE_ALLOWED_EMAILS.split(','),
  )(request);

export const config = {
  path: '/api/account-exists',
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: 'ip',
    windowSize: 60,
    windowLimit: 10,
  },
};
