import User from '../models/User.js';

export const getStaffEmails = async (roles = ['super_user']) => {
  const users = await User.find({
    role: { $in: roles },
    status: 'active',
  }).select('email');

  const emails = users.map((user) => user.email).filter(Boolean);
  if (process.env.ADMIN_EMAIL) {
    emails.push(process.env.ADMIN_EMAIL);
  }

  const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
  const real = unique.filter((email) => !/@(company\.com|example\.com)$/i.test(email));
  return real.length > 0 ? real : unique;
};
