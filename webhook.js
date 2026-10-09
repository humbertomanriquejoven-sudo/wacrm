const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const PORT = process.env.PORT || 3000;

app.get('/webhook', (req, res) => {
  const mode = req.query.mode;
  const token = req.query.token;
  const challenge = req.query.challenge;

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  const entries = req.body.entry || [];
  if (entries.length === 0) return;

  const changes = entries[0].changes || [];
  if (changes.length === 0) return;

  const value = changes[0].value || {};
  const contacts = value.contacts || [];
  if (contacts.length === 0) return;

  const contact = contacts[0];
  const wa_id = contact.wa_id;
  const user_id = contact.user_id;
  const name = contact.profile?.name;

  if (!wa_id || !user_id) return;

  const { error: checkError, data: checkData } = await supabase
    .from('contacts')
    .select('wa_id, wa_user')
    .limit(1)
    .single();

  const columnsExist = !checkError && checkData && checkData.wa_id !== undefined;

  if (!columnsExist) {
    await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_id TEXT; ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_user TEXT;`
    }).catch(() => {
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_id TEXT; ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_user TEXT;` })
      }).catch(e => console.error('Failed to add columns via RPC:', e));
    });
  }

  await supabase.from('contacts').upsert(
    {
      wa_id: wa_id,
      wa_user: user_id,
      phone: wa_id,
      name: name,
    },
    { onConflict: 'wa_id' }
  ).catch((err) => {
    console.error('Upsert error:', err);
  });
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});