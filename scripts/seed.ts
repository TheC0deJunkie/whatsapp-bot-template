import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

// Minimal dev seed. Creates one test user with no profile, so a simulator
// run starts from the true first-contact state.
async function main() {
  const phone = '+15550100001';
  const user = await prisma.user.upsert({
    where: { phone },
    update: { firstName: null, surname: null },
    create: { phone },
  });
  console.log(`seeded user: ${user.id} ${user.phone}`);

  // Clear the session so repeat seeds reset to first contact.
  await prisma.botSession.deleteMany({ where: { id: phone } });
  console.log('cleared session');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
