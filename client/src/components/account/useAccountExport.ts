import { useState } from 'react';
import { api } from '../../lib/api';

export function useAccountExport() {
  const [exporting, setExporting] = useState(false);

  const exportData = async () => {
    setExporting(true);
    try {
      const blob = await api.user.exportAccountData();
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `grareco-export-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setExporting(false);
    }
  };

  return { exporting, exportData };
}
