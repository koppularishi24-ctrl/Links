import React, { useState, useMemo, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Search, Plus, Settings, FolderOpen, ExternalLink, MoreVertical, Trash2, Edit2, Command, Download, Upload, FileText, Database, Cloud, LogIn, LogOut, User } from 'lucide-react';
import { get, set } from 'idb-keyval';
import CryptoJS from 'crypto-js';
import { auth, db, googleProvider } from './lib/firebase';
import { signInWithPopup, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp, getDocFromServer } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();
import { useLocalStorage } from './hooks/useLocalStorage';
import { Category, LinkItem } from './types';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';

// Default Data
const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat-1', name: 'Work', isExpanded: true },
  { id: 'cat-2', name: 'Personal', isExpanded: true },
  { id: 'cat-3', name: 'Read Later', isExpanded: true },
];

export default function App() {
  const [categories, setCategories] = useLocalStorage<Category[]>('vault-categories', DEFAULT_CATEGORIES);
  const [links, setLinks] = useLocalStorage<LinkItem[]>('vault-links', []);
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [savedHandle, setSavedHandle] = useState<FileSystemFileHandle | null>(null);
  const [isAttemptingReconnect, setIsAttemptingReconnect] = useState(true);
  
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [masterKey, setMasterKey] = useState<string | null>(null);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<LinkItem | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  const [confirmDialog, setConfirmDialog] = useState<{message: string, onConfirm: () => void} | null>(null);
  const [promptDialog, setPromptDialog] = useState<{ 
    title: string; 
    placeholder: string; 
    defaultValue?: string;
    isPassword?: boolean;
    onSubmit: (value: string, secondary?: string) => void 
  } | null>(null);
  const [alertDialog, setAlertDialog] = useState<{message: string} | null>(null);

  // Initialize from IDB
  useEffect(() => {
    get('vault-file-handle').then(async (handle) => {
      if (handle) {
        try {
          const permission = await handle.queryPermission({ mode: 'readwrite' });
          if (permission === 'granted') {
            await loadFromFileHandle(handle);
          } else {
            setSavedHandle(handle);
          }
        } catch (e) {
          console.error(e);
        }
      }
      setIsAttemptingReconnect(false);
    });
  }, []);

  // Initialize Firebase Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        if (masterKey) fetchFromCloud(currentUser.uid);
      } else {
        // Clear sensitive state on sign out to prevent data persistence
        setMasterKey(null);
        setCategories([]);
        setLinks([]);
      }
    });
    return () => unsubscribe();
  }, [masterKey]);

  const fetchFromCloud = async (userId: string) => {
    if (!masterKey) return;
    try {
      setIsSyncing(true);
      const vaultPath = `vaults/${userId}`;
      let vaultDoc;
      try {
        vaultDoc = await getDoc(doc(db, 'vaults', userId));
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, vaultPath);
        return;
      }
      
      if (vaultDoc.exists()) {
        const data = vaultDoc.data();
        if (data.payload && typeof data.payload === 'string') {
          try {
            const bytes = CryptoJS.AES.decrypt(data.payload, masterKey);
            const decryptedContent = bytes.toString(CryptoJS.enc.Utf8);
            if (!decryptedContent) throw new Error("Invalid key");
            
            const decryptedData = JSON.parse(decryptedContent);
            
            if (decryptedData.categories && decryptedData.links) {
              setCategories(decryptedData.categories);
              setLinks(decryptedData.links);
            }
          } catch (e) {
            setMasterKey(null); // Reset key if decryption fails
            setAlertDialog({ message: "Failed to decrypt cloud data. Verification failed." });
          }
        }
      }
    } catch (err) {
      console.error('Cloud fetch failed:', err);
    } finally {
      setIsSyncing(false);
    }
  };

  const pushToCloud = async () => {
    if (!user || !masterKey) return;
    try {
      setIsSyncing(true);
      const encryptedPayload = CryptoJS.AES.encrypt(
        JSON.stringify({ categories, links }), 
        masterKey
      ).toString();

      const vaultPath = `vaults/${user.uid}`;
      try {
        await setDoc(doc(db, 'vaults', user.uid), {
          payload: encryptedPayload,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, vaultPath);
      }
    } catch (err) {
      console.error('Cloud sync failed:', err);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (user && masterKey && (categories.length > 0 || links.length > 0)) {
        pushToCloud();
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [categories, links, user, masterKey]);

  const loadFromFileHandle = async (handle: FileSystemFileHandle) => {
    try {
      const file = await handle.getFile();
      const content = await file.text();
      const data = JSON.parse(content);
      if (data.categories && data.links) {
        setCategories(data.categories);
        setLinks(data.links);
        setFileHandle(handle);
        setSavedHandle(null);
      }
    } catch (err) {
      console.error('Failed to load from file handle', err);
    }
  };

  const reconnectSavedHandle = async () => {
    if (!savedHandle) return;
    try {
      const permission = await savedHandle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        await loadFromFileHandle(savedHandle);
        setAlertDialog({ message: 'Successfully reconnected to your file!' });
      }
    } catch (err) {
      console.error(err);
      setAlertDialog({ message: 'Failed to reconnect. You may need to link the file again.' });
    }
  };

  // Auto-sync to file system if handle exists
  useEffect(() => {
    if (!fileHandle) return;
    set('vault-file-handle', fileHandle).catch(console.error);

    const syncToFile = async () => {
      try {
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify({ categories, links }, null, 2));
        await writable.close();
      } catch (err) {
        console.error('Failed to sync to file:', err);
      }
    };
    syncToFile();
  }, [categories, links, fileHandle]);

  // Keyboard shortcut listener (Cmd/Ctrl + K to search, Cmd/Ctrl + I to add)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
        e.preventDefault();
        setIsAddModalOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleCreateCategory = () => {
    setPromptDialog({
      title: 'New Category',
      placeholder: 'Category name',
      onSubmit: (name: string) => {
        if (!name.trim()) return;
        const newCategory: Category = {
          id: uuidv4(),
          name: name.trim(),
          isExpanded: true,
        };
        setCategories(prev => [...prev, newCategory]);
        setPromptDialog(null);
      }
    });
  };

  const handleEditCategory = (id: string) => {
    const category = categories.find(c => c.id === id);
    if (!category) return;
    setPromptDialog({
      title: 'Edit Category',
      placeholder: 'Category name',
      defaultValue: category.name,
      onSubmit: (name: string) => {
        if (!name.trim()) return;
        setCategories(prev => prev.map(c => c.id === id ? { ...c, name: name.trim() } : c));
        setPromptDialog(null);
      }
    });
  };

  const handleToggleCategory = (id: string) => {
    setCategories(categories.map(c => c.id === id ? { ...c, isExpanded: !c.isExpanded } : c));
  };

  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return categories;
    const lowerQuery = searchQuery.toLowerCase();
    
    // If searching, we also filter categories that have matching links or match the name
    return categories.filter(cat => {
      const matchName = cat.name.toLowerCase().includes(lowerQuery);
      const hasMatchingLinks = links.some(link => 
        link.categoryId === cat.id && 
        (link.title.toLowerCase().includes(lowerQuery) || 
         link.url.toLowerCase().includes(lowerQuery) || 
         link.tags.some(t => t.toLowerCase().includes(lowerQuery)))
      );
      return matchName || hasMatchingLinks;
    });
  }, [categories, links, searchQuery]);

  const handleOpenAll = (categoryId: string) => {
    const categoryLinks = links.filter(l => l.categoryId === categoryId);
    if (categoryLinks.length === 0) return;
    
    // Open links with synthetic delay
    categoryLinks.forEach((link, index) => {
      setTimeout(() => {
        window.open(link.url, '_blank', 'noopener,noreferrer');
      }, index * 200); // 200ms delay between tabs
    });
  };

  const deleteLink = (id: string) => {
    setConfirmDialog({
      message: 'Are you sure you want to delete this link?',
      onConfirm: () => {
        setLinks(prev => prev.filter(l => l.id !== id));
        setConfirmDialog(null);
      }
    });
  };

  const deleteCategory = (id: string) => {
    setConfirmDialog({
      message: 'Delete this category and ALL its links?',
      onConfirm: () => {
        setCategories(prev => prev.filter(c => c.id !== id));
        setLinks(prev => prev.filter(l => l.categoryId !== id));
        setConfirmDialog(null);
      }
    });
  };

  const handleExport = () => {
    const data = { categories, links };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vault-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setIsSettingsOpen(false);
  };

  const handleLinkLocalFile = async () => {
    try {
      // @ts-ignore - File System Access API
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }],
      });
      const file = await handle.getFile();
      const content = await file.text();
      const data = JSON.parse(content);
      
      if (data.categories && data.links) {
        setCategories(data.categories);
        setLinks(data.links);
        setFileHandle(handle);
        setAlertDialog({ message: 'Successfully linked to local file! Changes will now auto-save.' });
      } else {
        setAlertDialog({ message: 'Invalid file format.' });
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setAlertDialog({ message: 'Failed to access file. Check browser permissions.' });
      }
    }
    setIsSettingsOpen(false);
  };

  const handleCreateLocalFile = async () => {
    try {
      // @ts-ignore
      const handle = await window.showSaveFilePicker({
        suggestedName: `vault-data.json`,
        types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }],
      });
      setFileHandle(handle);
      
      // Write current state immediately
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify({ categories, links }, null, 2));
      await writable.close();
      
      setAlertDialog({ message: 'New vault file created and linked! Changes will auto-save to this file.' });
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setAlertDialog({ message: 'Failed to create file.' });
      }
    }
    setIsSettingsOpen(false);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        if (data.categories && data.links) {
          setCategories(data.categories);
          setLinks(data.links);
          setAlertDialog({ message: 'Import successful!' });
        } else {
          setAlertDialog({ message: 'Invalid file format.' });
        }
      } catch (err) {
        setAlertDialog({ message: 'Failed to parse JSON file.' });
      }
    };
    reader.readAsText(file);
    setIsSettingsOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImportText = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      // Match all URLs starting with http:// or https://
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const matches = text.match(urlRegex);

      if (matches && matches.length > 0) {
        // Remove duplicates
        const uniqueUrls = Array.from(new Set(matches));
        
        const importedCategoryId = uuidv4();
        const newCategory: Category = {
          id: importedCategoryId,
          name: `Imported TXT (${new Date().toLocaleDateString()})`,
          isExpanded: true,
        };

        const newLinks: LinkItem[] = uniqueUrls.map(url => {
          let title = url;
          try {
            title = new URL(url).hostname.replace('www.', '');
          } catch(err) {
            // keep raw URL as title if parsing fails
          }
          return {
            id: uuidv4(),
            title,
            url,
            categoryId: importedCategoryId,
            tags: ['imported'],
            createdAt: Date.now()
          };
        });

        setCategories(prev => [newCategory, ...prev]);
        setLinks(prev => [...newLinks, ...prev]);
        
        setAlertDialog({ message: `Successfully imported ${newLinks.length} links from the text file!` });
      } else {
        setAlertDialog({ message: 'No valid URLs found in the text file. Make sure they start with http:// or https://' });
      }
    };
    reader.readAsText(file);
    setIsSettingsOpen(false);
    if (textInputRef.current) textInputRef.current.value = '';
  };

  const handleCloudAuth = async () => {
    if (user) {
      await auth.signOut();
      setMasterKey(null);
    } else {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err: any) {
        setAlertDialog({ message: `Google Login failed: ${err.message}` });
      }
    }
  };

  // If logged in but no master key, we need to prompt for it
  useEffect(() => {
    if (user && !masterKey) {
      setPromptDialog({
        title: "Unlock Your Vault",
        placeholder: "Enter Master Password",
        isPassword: true,
        onSubmit: (val1, val2) => {
          const password = val2 || val1;
          if (!password) {
            setAlertDialog({ message: "Master password is required to decrypt your data." });
            return;
          }
          setMasterKey(password);
          setPromptDialog(null);
        }
      });
    }
  }, [user, masterKey]);

  return (
    <div className="h-screen flex overflow-hidden bg-[var(--color-bg)] text-[var(--color-text-p)] selection:bg-[var(--color-accent-soft)] selection:text-[var(--color-accent)] font-sans antialiased text-sm">
      
      {/* Sidebar Layout */}
      <aside className="w-[240px] bg-[var(--color-sidebar)] border-r border-[var(--color-border)] flex flex-col py-6 px-4 shrink-0 overflow-y-auto hidden md:flex">
        <div className="text-[14px] font-bold tracking-[0.05em] uppercase text-[var(--color-text-s)] mb-8 flex items-center gap-2">
          <Command className="w-5 h-5 text-[var(--color-accent)]" />
          LinkVault
        </div>

        <nav className="mb-6">
          <div className="text-[11px] font-semibold text-[var(--color-text-s)] uppercase mb-3 pl-2">Library</div>
          <div className="flex items-center px-3 py-2.5 rounded-lg text-[13px] text-[var(--color-accent)] bg-[var(--color-accent-soft)] cursor-pointer mb-1 transition-all">
            <span className="font-medium">All Vaults</span>
            <span className="ml-auto text-[11px] opacity-50 font-medium">{links.length}</span>
          </div>
          <div className="flex items-center px-3 py-2.5 rounded-lg text-[13px] text-[var(--color-text-p)] hover:bg-[var(--color-card)] cursor-pointer mb-1 transition-all">
            <span>Pinned</span>
            <span className="ml-auto text-[11px] opacity-50 font-medium">0</span>
          </div>
        </nav>

        <nav className="mb-6">
           <div className="text-[11px] font-semibold text-[var(--color-text-s)] uppercase mb-3 pl-2 flex items-center justify-between">
             Categories
             <button onClick={handleCreateCategory} className="text-[var(--color-text-s)] hover:text-[var(--color-text-p)] p-1 rounded-md transition-colors"><Plus className="w-3.5 h-3.5" /></button>
           </div>
           {categories.map(c => (
             <div key={c.id} onClick={() => handleToggleCategory(c.id)} className="flex items-center px-3 py-2.5 rounded-lg text-[13px] text-[var(--color-text-p)] hover:bg-[var(--color-card)] cursor-pointer mb-1 transition-all group">
               <span className="truncate flex-1">{c.name}</span>
               <span className="ml-auto text-[11px] opacity-50 font-medium group-hover:hidden">{links.filter(l => l.categoryId === c.id).length}</span>
               <div className="hidden group-hover:flex items-center gap-1 ml-1">
                 <button 
                   onClick={(e) => { e.stopPropagation(); handleEditCategory(c.id); }}
                   className="p-1 rounded hover:text-[var(--color-accent)] text-[var(--color-text-s)] transition-colors"
                   title="Edit category"
                 >
                   <Edit2 className="w-3.5 h-3.5" />
                 </button>
                 <button 
                   onClick={(e) => { e.stopPropagation(); deleteCategory(c.id); }}
                   className="p-1 rounded hover:text-red-400 text-[var(--color-text-s)] transition-colors"
                   title="Delete category"
                 >
                   <Trash2 className="w-3.5 h-3.5" />
                 </button>
               </div>
             </div>
           ))}
        </nav>

        <nav className="mb-6">
          <div className="text-[11px] font-semibold text-[var(--color-text-s)] uppercase mb-3 pl-2">Cloud Sync</div>
          <button 
            onClick={handleCloudAuth}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-[13px] transition-all",
              user ? "text-green-400 bg-green-500/10" : "text-[var(--color-text-p)] hover:bg-[var(--color-card)]"
            )}
          >
            <Cloud className={cn("w-4 h-4", isSyncing && "animate-pulse")} />
            <span className="flex-1 text-left truncate">
              {user ? (user.displayName || user.email?.split('@')[0]) : "Connect with Google"}
            </span>
            {user ? <LogOut className="w-3 h-3 opacity-50" /> : <LogIn className="w-3 h-3 opacity-50" />}
          </button>
          
          {user && (
            <div className="mt-2 px-3 text-[10px] text-[var(--color-text-s)] flex items-center gap-2">
              <div className={cn("w-1.5 h-1.5 rounded-full", isSyncing ? "bg-amber-400 animate-bounce" : "bg-green-500")} />
              {isSyncing ? "Syncing..." : "Up to date"}
            </div>
          )}
        </nav>

        <div className="mt-auto pt-4 border-t border-[var(--color-border)]">
          <div className={cn(
            "p-3 rounded-xl border text-[11px] flex flex-col gap-2",
            fileHandle 
              ? "bg-green-500/5 border-green-500/20 text-green-400" 
              : "bg-amber-500/5 border-amber-500/20 text-amber-400"
          )}>
            <div className="flex items-center gap-2 font-bold uppercase tracking-wider">
              <Database className="w-3 h-3" />
              {fileHandle ? 'Synced to Disk' : 'Browser Memory'}
            </div>
            <p className="opacity-80 leading-relaxed">
              {fileHandle 
                ? "Your data is safely stored in a local file. Clearing browser history will NOT delete your links."
                : (user 
                   ? "Syncing to Cloud. Your links are safe even if you clear history." 
                   : "Note: Clearing browser history WILL delete these links. Setup sync or link to local file for permanent safety.")}
            </p>
            {!fileHandle && !user && (
              <button 
                onClick={handleCreateLocalFile}
                className="mt-1 w-full py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded-md font-bold transition-colors"
              >
                Setup Permanent Sync
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-[var(--color-bg)] h-full overflow-hidden">
        
        {/* Banner for Saved Handle */}
        <AnimatePresence>
          {savedHandle && !isAttemptingReconnect && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-[#10b981]/10 border-b border-[#10b981]/20">
              <div className="px-8 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Database className="w-5 h-5 text-[#10b981]" />
                  <div>
                    <h4 className="text-[13px] font-medium text-[#10b981]">Offline file detected</h4>
                    <p className="text-[12px] text-[#10b981]/80">Please reconnect to your local file to load your links automatically.</p>
                  </div>
                </div>
                <button onClick={reconnectSavedHandle} className="px-4 py-1.5 text-[12px] font-medium bg-[#10b981] text-black hover:bg-[#10b981]/90 rounded-md transition-colors">
                  Reconnect
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top Bar */}
        <div className="h-16 px-8 flex items-center border-b border-[var(--color-border)] gap-5 shrink-0 bg-[var(--color-bg)] z-10 w-full relative">
          <div className="flex-1 max-w-2xl relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-s)]" />
            <input 
              id="search-input"
              type="text"
              placeholder="Search for links or tags..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg py-2 pl-10 pr-10 text-[14px] text-[var(--color-text-p)] placeholder:text-[var(--color-text-s)] focus:outline-none focus:border-[var(--color-accent)] transition-all"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
               <kbd className="text-[10px] bg-[var(--color-bg)] border border-[var(--color-border)] px-1.5 py-0.5 rounded text-[var(--color-text-s)] font-mono">⌘K</kbd>
            </div>
          </div>

          <div className="flex items-center gap-3 ml-auto shrink-0">
             <div className="relative">
               <button 
                 onClick={() => setIsSettingsOpen(!isSettingsOpen)}
                 className="p-2.5 rounded-lg bg-[var(--color-card)] hover:bg-[#262629] text-[var(--color-text-s)] hover:text-white transition-colors border border-[var(--color-border)]"
                 title="Settings & Data"
               >
                 <Settings className="w-4 h-4" />
               </button>
               
               <AnimatePresence>
                 {isSettingsOpen && (
                   <>
                     <div className="fixed inset-0 z-40" onClick={() => setIsSettingsOpen(false)} />
                     <motion.div 
                       initial={{ opacity: 0, scale: 0.95, y: 10 }}
                       animate={{ opacity: 1, scale: 1, y: 0 }}
                       exit={{ opacity: 0, scale: 0.95, y: 10 }}
                       className="absolute right-0 top-full mt-2 w-48 bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl shadow-2xl z-50 overflow-hidden text-[13px]"
                     >
                       <button onClick={handleExport} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[var(--color-border)] text-left transition-colors">
                         <Download className="w-4 h-4 text-[var(--color-text-s)]" />
                         Export JSON
                       </button>
                       <button onClick={() => fileInputRef.current?.click()} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[var(--color-border)] text-left transition-colors">
                         <Upload className="w-4 h-4 text-[var(--color-text-s)]" />
                         Import JSON
                       </button>
                       <button onClick={() => textInputRef.current?.click()} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[var(--color-border)] text-left transition-colors border-t border-[var(--color-border)]">
                         <Upload className="w-4 h-4 text-[var(--color-text-s)]" />
                         Import TXT File
                       </button>
                       <input type="file" accept=".json" ref={fileInputRef} onChange={handleImport} className="hidden" />
                       {fileHandle && (
                         <div className="px-4 py-3 text-xs text-[#10b981] font-medium border-t border-[#10b981]/10 bg-[#10b981]/5">
                           ● Persisting to Local File
                         </div>
                       )}
                       {'showOpenFilePicker' in window && (
                         <>
                           <button onClick={handleLinkLocalFile} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[var(--color-border)] text-left transition-colors border-t border-[var(--color-border)]">
                             <FolderOpen className="w-4 h-4 text-[var(--color-text-s)]" />
                             Link Local File
                           </button>
                           <button onClick={handleCreateLocalFile} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[var(--color-border)] text-left transition-colors text-[var(--color-accent)] border-t border-[var(--color-border)]">
                             <FileText className="w-4 h-4 text-[var(--color-accent)]" />
                             Create Local File
                           </button>
                         </>
                       )}
                       <input type="file" accept=".txt" ref={textInputRef} onChange={handleImportText} className="hidden" />
                     </motion.div>
                   </>
                 )}
               </AnimatePresence>
             </div>
             <button 
               onClick={() => setIsAddModalOpen(true)}
               className="bg-[var(--color-accent)] text-white border-none py-2 px-5 rounded-lg text-[13px] font-semibold cursor-pointer hover:opacity-90 transition-opacity whitespace-nowrap hidden sm:block"
             >
               + Add Link
             </button>
          </div>
        </div>

        {/* Scrolling Grid Area */}
        <div className="flex-1 overflow-y-auto p-8 relative">
          <div className="max-w-6xl mx-auto space-y-10 pb-20">
            {filteredCategories.map(category => (
              <CategorySection 
                key={category.id}
                category={category}
                onToggle={() => handleToggleCategory(category.id)}
                onOpenAll={() => handleOpenAll(category.id)}
                links={links.filter(l => l.categoryId === category.id)}
                searchQuery={searchQuery}
                onEdit={setEditingLink}
                onDelete={deleteLink}
                onEditCategory={() => handleEditCategory(category.id)}
                onDeleteCategory={() => deleteCategory(category.id)}
              />
            ))}

            {filteredCategories.length === 0 && (
              <div className="text-center py-20 text-[var(--color-text-s)]">
                No results found.
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Quick Add Modal */}
      <AnimatePresence>
        {(isAddModalOpen || editingLink) && (
          <LinkModal 
            onClose={() => {
              setIsAddModalOpen(false);
              setEditingLink(null);
            }}
            onSave={(link) => {
              if (editingLink) {
                setLinks(links.map(l => l.id === link.id ? link : l));
              } else {
                setLinks([...links, link]);
              }
              setIsAddModalOpen(false);
              setEditingLink(null);
            }}
            categories={categories}
            initialData={editingLink}
          />
        )}
      </AnimatePresence>

      {/* Global Dialogs */}
      <AnimatePresence>
        {confirmDialog && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm" onClick={() => setConfirmDialog(null)} />
            <motion.div initial={{scale:0.95,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.95,opacity:0}} className="relative bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <h3 className="text-[16px] font-semibold mb-2 text-[var(--color-text-p)]">Confirm Action</h3>
              <p className="text-[var(--color-text-s)] text-[13px] mb-6">{confirmDialog.message}</p>
              <div className="flex justify-end gap-3">
                <button onClick={() => setConfirmDialog(null)} className="px-4 py-2 text-[13px] font-medium hover:bg-[var(--color-border)] text-[var(--color-text-p)] rounded-lg transition-colors">Cancel</button>
                <button onClick={confirmDialog.onConfirm} className="px-4 py-2 text-[13px] font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded-lg transition-colors">Delete</button>
              </div>
            </motion.div>
          </div>
        )}

        {promptDialog && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm" onClick={() => setPromptDialog(null)} />
            <motion.div initial={{scale:0.95,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.95,opacity:0}} className="relative bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <h3 className="text-[16px] font-semibold mb-2 text-[var(--color-text-p)]">{promptDialog.title}</h3>
              <p className="text-[var(--color-text-s)] text-[12px] mb-4">
                {promptDialog.title === "Unlock Your Vault" 
                  ? "Your data is encrypted. Enter your Master Password to decrypt and sync your links."
                  : promptDialog.title === "New Category"
                  ? "Enter a name for the new category." 
                  : "Enter the required information below."}
              </p>
              
              <form onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                const field1 = formData.get('field1') as string;
                const field2 = formData.get('field2') as string;
                promptDialog.onSubmit(field1, field2);
              }} className="space-y-3">
                {promptDialog.title === "Unlock Your Vault" ? (
                  <input 
                    autoFocus
                    name="field1" 
                    type="password"
                    placeholder="Master Password"
                    className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[14px] focus:border-[var(--color-accent)] focus:outline-none text-[var(--color-text-p)] transition-colors" 
                  />
                ) : (
                  <>
                    <input 
                      autoFocus 
                      name="field1" 
                      type={promptDialog.isPassword ? "email" : "text"}
                      placeholder={promptDialog.placeholder} 
                      defaultValue={promptDialog.defaultValue || ''}
                      className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[14px] focus:border-[var(--color-accent)] focus:outline-none text-[var(--color-text-p)] transition-colors" 
                    />
                    
                    {promptDialog.isPassword && (
                      <input 
                        name="field2" 
                        type="password"
                        placeholder="Vault Password"
                        className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[14px] focus:border-[var(--color-accent)] focus:outline-none text-[var(--color-text-p)] transition-colors" 
                      />
                    )}
                  </>
                )}

                <div className="flex justify-end gap-3 pt-3">
                  <button type="button" onClick={() => setPromptDialog(null)} className="px-4 py-2 text-[13px] font-medium hover:bg-[var(--color-border)] text-[var(--color-text-s)] rounded-lg transition-colors">Cancel</button>
                  <button type="submit" className="px-4 py-2 text-[13px] font-medium bg-[var(--color-accent)] text-white hover:opacity-90 rounded-lg transition-opacity">
                    Confirm
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {alertDialog && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm" onClick={() => setAlertDialog(null)} />
            <motion.div initial={{scale:0.95,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.95,opacity:0}} className="relative bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <h3 className="text-[16px] font-semibold mb-2 text-[var(--color-text-p)]">Notice</h3>
              <p className="text-[var(--color-text-s)] text-[13px] mb-6">{alertDialog.message}</p>
              <div className="flex justify-end">
                <button onClick={() => setAlertDialog(null)} className="px-4 py-2 text-[13px] font-medium bg-[var(--color-accent)] text-white hover:opacity-90 rounded-lg transition-opacity">OK</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}

// Subcomponents

function CategorySection({ 
  category, 
  onToggle, 
  onOpenAll, 
  links, 
  searchQuery,
  onEdit,
  onDelete,
  onEditCategory,
  onDeleteCategory
}: { 
  category: Category; 
  onToggle: () => void; 
  onOpenAll: () => void; 
  links: LinkItem[];
  searchQuery: string;
  onEdit: (link: LinkItem) => void;
  onDelete: (id: string) => void;
  onEditCategory: () => void;
  onDeleteCategory: () => void;
}) {
  
  const filteredLinks = useMemo(() => {
    if (!searchQuery.trim()) return links;
    const lowerQuery = searchQuery.toLowerCase();
    return links.filter(l => 
      l.title.toLowerCase().includes(lowerQuery) || 
      l.url.toLowerCase().includes(lowerQuery) || 
      l.tags.some(t => t.toLowerCase().includes(lowerQuery))
    );
  }, [links, searchQuery]);

  // If searching, hide category if no links match (unless category name explicitly matches)
  if (searchQuery.trim() && filteredLinks.length === 0 && !category.name.toLowerCase().includes(searchQuery.toLowerCase())) {
    return null;
  }

  return (
    <div className="group/category">
      <div className="flex items-center justify-between mb-5">
        <div className="text-[18px] font-semibold text-[var(--color-text-p)] flex items-center gap-2.5 group/catheader">
          <span>{category.name}</span>
          <span className="text-[var(--color-text-s)] text-[14px] font-normal">({filteredLinks.length})</span>
          <button 
            onClick={onEditCategory}
            className="p-1.5 opacity-0 group-hover/catheader:opacity-100 transition-opacity text-[var(--color-text-s)] hover:text-white rounded-md bg-[var(--color-card)] border border-[var(--color-border)]"
            title="Edit Category Name"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button 
            onClick={onDeleteCategory}
            className="p-1.5 opacity-0 group-hover/catheader:opacity-100 transition-opacity text-[var(--color-text-s)] hover:text-red-400 rounded-md bg-[var(--color-card)] border border-[var(--color-border)]"
            title="Delete Category"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        
        <div className="flex items-center gap-3">
          {links.length > 0 && (
            <button 
              onClick={(e) => { e.stopPropagation(); onOpenAll(); }}
              className="text-[12px] font-medium px-3 py-1.5 rounded-md bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text-p)] hover:opacity-80 transition-opacity flex items-center gap-1.5"
            >
              Bulk Open Selected
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredLinks.length === 0 ? (
          <div className="col-span-full py-8 text-[13px] text-[var(--color-text-s)] italic text-center bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl">
            No links in this category
          </div>
        ) : (
          filteredLinks.map(link => (
            <LinkRow 
              key={link.id} 
              link={link} 
              onEdit={() => onEdit(link)} 
              onDelete={() => onDelete(link.id)} 
            />
          ))
        )}
      </div>
    </div>
  );
}

function LinkRow({ link, onEdit, onDelete }: { link: LinkItem; onEdit: () => void; onDelete: () => void; }) {
  // Try to extract hostname for display
  let hostname = link.url;
  try {
    hostname = new URL(link.url).hostname.replace('www.', '');
  } catch (e) {
    // ignore
  }

  return (
    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-4 cursor-pointer transition-all duration-200 hover:-translate-y-[2px] hover:border-[var(--color-accent)] group/card flex flex-col relative overflow-hidden">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center shrink-0 font-bold text-[var(--color-accent)] text-[14px]">
          {hostname.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0 pr-6">
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="block outline-none">
            <h3 className="text-[14px] font-semibold text-[var(--color-text-p)] mb-0.5 truncate group-hover/card:text-[var(--color-accent)] transition-colors">
              {link.title}
            </h3>
            <p className="text-[11px] text-[var(--color-text-s)] truncate">
              {hostname}
            </p>
          </a>
        </div>
      </div>
      
      {/* Absolute positioned actions */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity bg-[var(--color-card)] shadow-[0_0_10px_10px_var(--color-card)] z-10 pl-1 rounded">
        <button 
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(link.url, '_blank', 'noopener,noreferrer'); }}
          className="p-1.5 text-[var(--color-text-s)] hover:text-indigo-400 rounded transition-colors bg-[var(--color-bg)] hover:bg-[var(--color-border)] border border-[var(--color-border)]"
          title="Open in new tab"
        >
          <ExternalLink className="w-3 h-3" />
        </button>
        <button 
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(); }}
          className="p-1.5 text-[var(--color-text-s)] hover:text-white rounded transition-colors bg-[var(--color-bg)] hover:bg-[var(--color-border)] border border-[var(--color-border)]"
          title="Edit"
        >
          <Edit2 className="w-3 h-3" />
        </button>
        <button 
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}
          className="p-1.5 text-[var(--color-text-s)] hover:text-red-400 rounded transition-colors bg-[var(--color-bg)] hover:bg-[var(--color-border)] border border-[var(--color-border)]"
          title="Delete"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      
      <div className="flex flex-wrap gap-1.5 mt-auto pt-2">
        {link.tags.map((tag, i) => (
          <span key={i} className="text-[10px] px-2 py-0.5 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-s)] whitespace-nowrap">
            #{tag}
          </span>
        ))}
      </div>
    </div>
  );
}

// Modal
function LinkModal({ 
  onClose, 
  onSave, 
  categories,
  initialData 
}: { 
  onClose: () => void; 
  onSave: (link: LinkItem) => void;
  categories: Category[];
  initialData?: LinkItem | null;
}) {
  const [title, setTitle] = useState(initialData?.title || '');
  const [url, setUrl] = useState(initialData?.url || '');
  const [categoryId, setCategoryId] = useState(initialData?.categoryId || categories[0]?.id || '');
  const [tagsStr, setTagsStr] = useState(initialData?.tags.join(', ') || '');
  const [notes, setNotes] = useState(initialData?.notes || '');

  // Auto-fetch title from URL (simple heuristic based on url string since we can't reliably scrape offline)
  const handleUrlBlur = () => {
    if (url && !title) {
      try {
        const u = new URL(url);
        let defaultTitle = u.hostname.replace('www.', '');
        // capitalize
        defaultTitle = defaultTitle.charAt(0).toUpperCase() + defaultTitle.slice(1).split('.')[0];
        setTitle(defaultTitle);
      } catch (e) {
        // ignore
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !url || !categoryId) return;

    // Fix url if missing protocol
    let finalUrl = url;
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = 'https://' + finalUrl;
    }

    onSave({
      id: initialData?.id || uuidv4(),
      title,
      url: finalUrl,
      categoryId,
      tags: tagsStr.split(',').map(t => t.trim()).filter(Boolean),
      notes,
      createdAt: initialData?.createdAt || Date.now(),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }} 
        animate={{ opacity: 1 }} 
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 10 }} 
        animate={{ opacity: 1, scale: 1, y: 0 }} 
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="relative w-full max-w-lg bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="p-5 border-b border-[var(--color-border)] flex justify-between items-center bg-[var(--color-sidebar)]">
          <h3 className="font-semibold text-[16px] text-[var(--color-text-p)]">{initialData ? 'Edit Link' : 'Add Link'}</h3>
          <button onClick={onClose} className="text-[var(--color-text-s)] hover:text-white transition-colors">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-text-s)] mb-2 uppercase tracking-wide">URL</label>
            <input 
              autoFocus
              type="text" 
              required
              value={url}
              onChange={e => setUrl(e.target.value)}
              onBlur={handleUrlBlur}
              placeholder="https://example.com"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-[14px] text-[var(--color-text-p)] focus:outline-none focus:border-[var(--color-accent)] font-mono transition-colors"
            />
          </div>
          
          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-text-s)] mb-2 uppercase tracking-wide">Title</label>
            <input 
              type="text" 
              required
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Example Site"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-[14px] text-[var(--color-text-p)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-text-s)] mb-2 uppercase tracking-wide">Category</label>
              <select 
                value={categoryId}
                onChange={e => setCategoryId(e.target.value)}
                required
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-[14px] text-[var(--color-text-p)] focus:outline-none focus:border-[var(--color-accent)] appearance-none transition-colors"
              >
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-text-s)] mb-2 uppercase tracking-wide">Tags</label>
              <input 
                type="text" 
                value={tagsStr}
                onChange={e => setTagsStr(e.target.value)}
                placeholder="design, tool"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-[14px] text-[var(--color-text-p)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
              />
            </div>
          </div>

          <div>
             <label className="block text-[11px] font-semibold text-[var(--color-text-s)] mb-2 uppercase tracking-wide">Notes (Optional)</label>
             <textarea 
               value={notes}
               onChange={e => setNotes(e.target.value)}
               placeholder="Why did you save this?"
               rows={2}
               className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-[14px] text-[var(--color-text-p)] focus:outline-none focus:border-[var(--color-accent)] resize-none transition-colors"
             />
          </div>

          <div className="pt-4 flex justify-end gap-2">
            <button 
              type="button" 
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--color-text-s)] hover:text-white hover:bg-[var(--color-border)] transition-colors"
            >
              Cancel
            </button>
            <button 
              type="submit"
              className="px-5 py-2 rounded-lg text-[13px] font-semibold bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
            >
              Save Link
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
