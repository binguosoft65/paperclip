import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-[0_1px_0_1px_hsl(var(--border))]">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  const { t } = useTranslation("keyboard");

  const sections = [
    {
      title: t('sections.inbox'),
      shortcuts: [
        { keys: ["j"], label: t('shortcuts.moveDown') },
        { keys: ["↓"], label: t('shortcuts.moveDown') },
        { keys: ["k"], label: t('shortcuts.moveUp') },
        { keys: ["↑"], label: t('shortcuts.moveUp') },
        { keys: ["←"], label: t('shortcuts.collapseGroup') },
        { keys: ["→"], label: t('shortcuts.expandGroup') },
        { keys: ["Enter"], label: t('shortcuts.openSelected') },
        { keys: ["a"], label: t('shortcuts.archive') },
        { keys: ["y"], label: t('shortcuts.archive') },
        { keys: ["r"], label: t('shortcuts.markRead') },
        { keys: ["U"], label: t('shortcuts.markUnread') },
      ],
    },
    {
      title: t('sections.issueDetail'),
      shortcuts: [
        { keys: ["y"], label: t('shortcuts.quickArchive') },
        { keys: ["g", "i"], label: t('shortcuts.goToInbox') },
        { keys: ["g", "c"], label: t('shortcuts.focusComment') },
      ],
    },
    {
      title: t('sections.global'),
      shortcuts: [
        { keys: ["/"], label: t('shortcuts.search') },
        { keys: ["c"], label: t('shortcuts.newIssue') },
        { keys: ["["], label: t('shortcuts.toggleSidebar') },
        { keys: ["]"], label: t('shortcuts.togglePanel') },
        { keys: ["?"], label: t('shortcuts.showShortcuts') },
      ],
    },
  ];

  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-1.5">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label + shortcut.keys.join()}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-foreground/90">{shortcut.label}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && <span className="text-xs text-muted-foreground">{t('then')}</span>}
                        <KeyCap>{key}</KeyCap>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          Press <KeyCap>Esc</KeyCap> to close &middot; Shortcuts are disabled in text fields
        </p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("keyboard");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">{t('keyboardShortcuts')}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
