import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableRow, TableCell, TableBody } from '@/components/ui/table';
import { AlertTriangle, ChevronDown, X } from 'lucide-react';

export function ContactsTable() {
  const [contacts, setContacts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTab, setSelectedTab] = useState('all');

  useEffect(() => {
    fetchContacts();
  }, []);

  const fetchContacts = async () => {
    setIsLoading(true);
    try {
      let query = supabase.from('contacts').select('*');

      if (searchQuery) {
        query = query.or(`name.ilike.%${searchQuery}%,phone.ilike.%${searchQuery}%,wa_id.ilike.%${searchQuery}%,wa_user.ilike.%${searchQuery}%`);
      }

      const { data, error } = await query.order('created', { ascending: false });

      if (error) throw error;
      setContacts(data);
    } catch (err) {
      console.error('Error fetching contacts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'phone', label: 'Phone' },
    { key: 'username', label: 'Username' },
    {
      key: 'wa_id',
      label: 'WA ID',
      className: 'text-purple-400',
    },
    {
      key: 'wa_user',
      label: 'WA User',
      className: 'text-purple-400',
    },
    { key: 'email', label: 'Email' },
    { key: 'company', label: 'Company' },
    { key: 'tags', label: 'Tags' },
    { key: 'created', label: 'Created' },
    { key: 'actions', label: 'Acciones', cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <button className="text-gray-400 hover:text-purple-400 transition">
          <X className="h-4 w-4" />
        </button>
      </div>
    )},
  ];

  return (
    <div className="bg-zinc-950 min-h-screen">
      <div className="p-4 border-b border-zinc-800">
        <h1 className="text-xl font-semibold">Contacts</h1>

        <div className="flex items-center gap-2 mt-3">
          <Button variant="outline" size="sm">Custom fields</Button>
          <Button variant="outline" size="sm">Import</Button>
          <Button size="sm" className="bg-purple-600 hover:bg-purple-500">
            + Add Contact
          </Button>
          <Input
            placeholder="Search..."
            value={searchQuery}
            onValueChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1"
          />
          <Button variant="outline" size="sm">Filter</Button>
        </div>
      </div>

      <div className="p-4 overflow-x-auto">
        {isLoading ? (
          <div className="min-h-[200px] flex items-center justify-center text-zinc-400">
            Loading...
          </div>
        ) : (
          <Table>
            <TableHeader>
              {columns.map((col) => (
                <TableRow key={col.key}>
                  <TableCell className="text-left">
                    {col.label}
                  </TableCell>
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="text-left">{contact.name || '-'}</TableCell>
                  <TableCell className="text-left">{contact.phone || '-'}</TableCell>
                  <TableCell className="text-left">{contact.username || '-'}</TableCell>
                  <TableCell className={`text-purple-400 ${contact.wa_id ? '' : 'opacity-50'}`}>
                    {contact.wa_id || '-'}
                  </TableCell>
                  <TableCell className={`text-purple-400 ${contact.wa_user ? '' : 'opacity-50'}`}>
                    {contact.wa_user || '-'}
                  </TableCell>
                  <TableCell className="text-left">{contact.email || '-'}</TableCell>
                  <TableCell className="text-left">{contact.company || '-'}</TableCell>
                  <TableCell className="text-left">{contact.tags || '-'}</TableCell>
                  <TableCell className="text-left">{contact.created_at ? new Date(contact.created_at).toLocaleDateString() : '-'}</TableCell>
                  <TableCell className="flex items-center gap-2">
                    <button className="text-gray-400 hover:text-purple-400 transition p-1 rounded">
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}