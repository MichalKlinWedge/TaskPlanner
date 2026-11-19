import { describe, expect, it } from 'vitest';

import { attachmentPath, attachmentView, fileAttachmentPatch, fileProblem, findUrl, isUrlOnly, linkName, linkPreviewOps, normalizePreview, sharedText, storageFileName, withLinkOps } from '../attachments.ts';
import { formatBytes } from '../format.ts';
import { AttachmentRow } from '../schemas/model.ts';

describe('adresy w tekście', () => {
  it('pierwszy adres bez interpunkcji końca zdania', () => {
    expect(findUrl('Przeczytać https://blog.pl/post-o-czyms, jutro')).toBe('https://blog.pl/post-o-czyms');
    expect(findUrl('(zob. https://pl.wikipedia.org/wiki/Kot_(ujednoznacznienie))')).toBe('https://pl.wikipedia.org/wiki/Kot_(ujednoznacznienie)');
    expect(findUrl('https://example.com/a#sekcja?x=1&y=!2')).toBe('https://example.com/a#sekcja?x=1&y=!2');
    expect(findUrl('bez adresu, ftp://x.pl i mailto:a@b.pl')).toBeNull();
    expect(isUrlOnly(' https://x.com/user/status/123 ')).toBe(true);
    expect(isUrlOnly('Przeczytać https://x.com')).toBe(false);
  });

  it('nazwa linku bez podglądu', () => {
    expect(linkName('https://www.onet.pl/')).toBe('onet.pl');
    expect(linkName('https://blog.pl/zielono%C5%9B%C4%87/wpis')).toBe('blog.pl/zieloność/wpis');
    expect(linkName(`https://a.pl/${'x'.repeat(200)}`)).toHaveLength(80);
  });
});

describe('pliki', () => {
  it('bezpieczna nazwa w kluczu Storage i ścieżka z folderem użytkownika i zadania', () => {
    expect(storageFileName('Zażółć gęślą jaźń (skan) #2.PDF')).toBe('Zazolc-gesla-jazn-skan-2.pdf');
    expect(storageFileName('.env')).toBe('env');
    expect(storageFileName('???')).toBe('plik');
    expect(storageFileName(`${'a'.repeat(300)}.jpeg`)).toHaveLength(100);
    expect(attachmentPath('u1', 't1', 'a1', 'Zdjęcie 1.jpg')).toBe('u1/t1/a1-Zdjecie-1.jpg');
  });

  it('rodzaj podglądu, limit 25 MB i rozmiar po polsku', () => {
    expect(attachmentView('image/jpeg')).toBe('image');
    expect(attachmentView('application/pdf')).toBe('pdf');
    expect(attachmentView('application/zip')).toBe('other');
    expect(fileProblem({ name: 'film.mp4', mime: 'video/mp4', size: 26 * 1024 * 1024 })).toMatch('25 MB');
    expect(fileProblem({ name: 'a.txt', mime: 'text/plain', size: 10 })).toBeNull();
    expect([830, 12_300, 3_565_158].map(formatBytes)).toEqual(['830 B', '12 kB', '3,4 MB']);
  });

  it('wiersz pliku przechodzi schemat `attachments`', () => {
    const patch = fileAttachmentPatch({ taskId: '01900000-0000-7000-8000-000000000001', storagePath: 'u/t/a-x.pdf', name: 'x.pdf', mime: 'application/pdf', size: 1000 });
    const { deleted_at: _, ...row } = patch;
    expect(AttachmentRow.safeParse({ id: '01900000-0000-7000-8000-000000000002', ...row }).success).toBe(true);
  });
});

describe('link → zadanie', () => {
  const created = () => ({ taskId: 't1', ops: [{ table: 'tasks' as const, id: 't1', patch: { title: 'x', source: { kind: 'quick_add', text: 'x' } } }] });

  it('szybkie dodawanie z adresem dokłada załącznik, źródło zostaje', () => {
    const ops = withLinkOps(created(), { title: 'Przeczytać https://blog.pl/a', newId: () => 'a1' });
    expect(ops).toHaveLength(2);
    expect(ops[0]!.patch.source).toEqual({ kind: 'quick_add', text: 'x' });
    expect(ops[1]).toMatchObject({ table: 'attachments', id: 'a1', patch: { task_id: 't1', kind: 'link', url: 'https://blog.pl/a', name: 'blog.pl/a', preview: null } });
    expect(withLinkOps(created(), { title: 'Bez adresu' })).toHaveLength(1);
  });

  it('udostępnienie zapisuje źródło `link`', () => {
    const ops = withLinkOps(created(), { title: 'https://x.pl/a', url: 'https://x.pl/a', shared: true, newId: () => 'a1' });
    expect(ops[0]!.patch.source).toEqual({ kind: 'link', url: 'https://x.pl/a' });
    const titled = withLinkOps(created(), { title: 'Artykuł o kotach', url: 'https://x.pl/a', shared: true });
    expect(titled[0]!.patch.source).toEqual({ kind: 'link', url: 'https://x.pl/a', title: 'Artykuł o kotach' });
  });

  it('tekst udostępnienia: adres z `text` (Chrome na Androidzie), tytuł strony bez powtórzeń', () => {
    expect(sharedText({ title: 'Artykuł', text: 'https://x.pl/a' })).toEqual({ text: 'Artykuł', url: 'https://x.pl/a' });
    expect(sharedText({ title: '', text: 'Zobacz to https://x.pl/a', url: '' })).toEqual({ text: 'Zobacz to', url: 'https://x.pl/a' });
    expect(sharedText({ url: 'https://x.pl/a' })).toEqual({ text: 'https://x.pl/a', url: 'https://x.pl/a' });
    expect(sharedText({ title: 'Notatka', text: 'Notatka' })).toEqual({ text: 'Notatka', url: null });
  });

  it('podgląd strony uzupełnia tytuł zadania tylko, gdy to wciąż sam adres', () => {
    const preview = normalizePreview({ title: '  Kot\n domowy ', siteName: 'Wikipedia', image: 'javascript:alert(1)', icon: 'https://pl.wikipedia.org/favicon.ico', extra: 1 });
    expect(preview).toEqual({ title: 'Kot domowy', siteName: 'Wikipedia', icon: 'https://pl.wikipedia.org/favicon.ico' });
    const att = { id: 'a1', url: 'https://pl.wikipedia.org/wiki/Kot' };
    expect(linkPreviewOps(att, { id: 't1', title: 'https://pl.wikipedia.org/wiki/Kot' }, preview)).toEqual([
      { table: 'attachments', id: 'a1', patch: { preview, name: 'Kot domowy' } },
      { table: 'tasks', id: 't1', patch: { title: 'Kot domowy' } },
    ]);
    expect(linkPreviewOps(att, { id: 't1', title: 'Poczytać o kotach' }, preview)).toHaveLength(1);
    expect(linkPreviewOps(att, null, {})).toEqual([{ table: 'attachments', id: 'a1', patch: { preview: {} } }]);
  });
});
