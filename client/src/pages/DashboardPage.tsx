import React, { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Mic,
  Calendar,
  Clock,
  Trash2,
  LogOut,
  Search,
  CheckSquare,
  Square,
  Wand2,
  Loader2,
  StopCircle,
  FileText,
  Pencil,
  Check,
  X,
  KeyRound,
  Monitor,
  Menu,
  Download,
  Shield,
  Image as ImageIcon,
} from "lucide-react";
import { Link, useLocation, useRoute } from "wouter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { api } from "@/lib/api";
import type { Meeting } from "shared";
import { AppHeader } from "@/components/layout/AppHeader";
import { OnboardingEmptyState } from "@/components/docs/OnboardingEmptyState";

function formatDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "-";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}時間${mins}分`;
  return `${mins}分`;
}

function getPlatformIcon(platform: string): React.ReactNode {
  if (platform === "web-recorder") return <Mic className="w-3 h-3" />;
  if (platform === "desktop-online" || platform === "desktop" || platform.startsWith("desktop"))
    return <Monitor className="w-3 h-3" />;
  if (platform === "desktop-real") return <Monitor className="w-3 h-3" />;
  const map: Record<string, string> = {
    zoom: "Z",
    meet: "G",
    teams: "T",
    webex: "W",
    unknown: "?",
  };
  return map[platform] ?? "?";
}

function InlineRename({
  meetingId,
  currentTitle,
  onDone,
}: {
  meetingId: number;
  currentTitle: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(currentTitle);
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (title: string) => {
      const res = await apiRequest("PATCH", `/api/meetings/${meetingId}`, { title });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/meetings"] });
      onDone();
      toast({ title: "会議名を変更しました" });
    },
    onError: () => {
      toast({ title: "変更に失敗しました", variant: "destructive" });
    },
  });

  const save = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentTitle) {
      mutation.mutate(trimmed);
    } else {
      onDone();
    }
  };

  return (
    <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") save();
          if (e.key === "Escape") onDone();
        }}
        className="h-7 text-sm flex-1 min-w-0"
      />
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={save} disabled={mutation.isPending}>
        {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onDone}>
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [, navigate] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [renamingId, setRenamingId] = useState<number | null>(null);

  const { data: meetings = [], isLoading, isError } = useQuery<Meeting[]>({
    queryKey: ["/api/meetings"],
    enabled: !!user,
    refetchInterval: 5000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/meetings/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/meetings"] });
      toast({ title: "削除しました" });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await apiRequest("POST", "/api/meetings/bulk-delete", { ids });
      return res.json();
    },
    onSuccess: (data: { deleted: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/meetings"] });
      setSelectedIds(new Set());
      setSelectionMode(false);
      toast({ title: `${data.deleted}件削除しました` });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/meetings/${id}/stop`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/meetings"] });
      toast({ title: "会議を停止しました" });
    },
  });

  const generateAllTitlesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/meetings/generate-all-titles");
      return res.json();
    },
    onSuccess: (data: { updated: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/meetings"] });
      toast({ title: `${data.updated}件のタイトルを自動生成しました` });
    },
    onError: (err) => {
      toast({
        title: "タイトル生成に失敗しました",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    },
  });

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const activeMeetings = meetings.filter((m) => m.status === "idle" || m.status === "active" || m.status === "paused");
  const completedMeetings = meetings.filter((m) => m.status === "completed");

  const filteredCompleted = completedMeetings.filter((m) =>
    m.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalDuration = completedMeetings.reduce((sum, m) => sum + Math.max(0, m.duration || 0), 0);
  const thisMonth = completedMeetings.filter((m) => {
    const d = new Date(m.startedAt);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  useEffect(() => {
    if (!selectionMode) return;
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visibleIds = new Set(
        completedMeetings
          .filter((m) => m.title.toLowerCase().includes(searchQuery.toLowerCase()))
          .map((m) => m.id),
      );
      let changed = false;
      const next = new Set<number>();
      prev.forEach((id) => {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const titles = ids
      .map((id) => meetings.find((m) => m.id === id)?.title)
      .filter((t): t is string => !!t);
    const preview = titles.slice(0, 5).map((t) => `・${t}`).join("\n");
    const more = titles.length > 5 ? `\n…ほか ${titles.length - 5} 件` : "";
    const ok = await confirm({
      title: `${ids.length} 件の会議を削除しますか？`,
      description: `削除すると元に戻せません。\n\n${preview}${more}`,
      confirmText: `${ids.length} 件を削除`,
      destructive: true,
    });
    if (ok) bulkDeleteMutation.mutate(ids);
  }, [selectedIds, meetings, confirm, bulkDeleteMutation]);

  const handleForceStop = useCallback(
    async (m: Meeting) => {
      const ok = await confirm({
        title: "会議を強制終了しますか？",
        description: `「${m.title}」を終了します。\n別のデバイスで文字起こし中の場合はその文字起こしも停止し、議事録メールの送信が行われます。`,
        confirmText: "強制終了する",
        destructive: true,
      });
      if (ok) stopMutation.mutate(m.id);
    },
    [confirm, stopMutation],
  );

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-primary" />
                <div>
                  <p className="text-2xl font-bold">{completedMeetings.length}</p>
                  <p className="text-sm text-muted-foreground">総会議数</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Clock className="w-5 h-5 text-primary" />
                <div>
                  <p className="text-2xl font-bold">{Math.round(totalDuration / 60)}分</p>
                  <p className="text-sm text-muted-foreground">総文字起こし時間</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="col-span-2 md:col-span-1">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Calendar className="w-5 h-5 text-primary" />
                <div>
                  <p className="text-2xl font-bold">{thisMonth}</p>
                  <p className="text-sm text-muted-foreground">今月の会議数</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {activeMeetings.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              進行中の会議
            </h2>
            <div className="space-y-3">
              {activeMeetings.map((m) => (
                <Card
                  key={m.id}
                  className="border-red-500/30 bg-red-500/5 cursor-pointer hover:border-red-500/50 hover:shadow-md transition-all"
                  onClick={() => navigate(`/meetings/${m.id}`)}
                >
                  <CardContent className="py-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      {m.status === "idle" ? (
                        <Badge variant="secondary" className="shrink-0">未開始</Badge>
                      ) : (
                        <Badge variant="destructive" className="gap-1 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                          {m.status === "paused" ? "一時停止" : "LIVE"}
                        </Badge>
                      )}
                      <span className="font-medium truncate">{m.title}</span>
                      {m.shareActive && (
                        <Badge
                          variant="outline"
                          className="gap-1 shrink-0 border-red-400 text-red-600 dark:text-red-400"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                          共有中
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleForceStop(m); }}
                        disabled={stopMutation.isPending}
                      >
                        <StopCircle className="w-3.5 h-3.5 mr-1.5" />
                        強制終了
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant="outline"
            onClick={() => generateAllTitlesMutation.mutate()}
            disabled={generateAllTitlesMutation.isPending}
          >
            {generateAllTitlesMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Wand2 className="w-4 h-4 mr-2" />
            )}
            AIタイトル一括生成
          </Button>
        </div>

        <section>
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <h2 className="text-lg font-semibold">会議一覧</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="会議を検索..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 w-48"
                />
              </div>
              <Button
                variant={selectionMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setSelectionMode(!selectionMode);
                  setSelectedIds(new Set());
                }}
              >
                <CheckSquare className="w-3.5 h-3.5 mr-1.5" />
                {selectionMode ? "選択解除" : "選択モード"}
              </Button>
              {selectionMode && selectedIds.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleBulkDelete}
                  disabled={bulkDeleteMutation.isPending}
                >
                  {bulkDeleteMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  {selectedIds.size}件削除
                </Button>
              )}
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardContent className="py-4">
                    <div className="animate-pulse h-5 bg-muted rounded w-48 mb-2" />
                    <div className="animate-pulse h-3 bg-muted rounded w-32" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : isError && meetings.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <h3 className="text-lg font-medium mb-2">会議一覧を取得できませんでした</h3>
                <p className="text-muted-foreground text-sm">
                  会議データが消えたわけではありません。通信状況をご確認のうえ、ページを再読み込みしてください。
                </p>
              </CardContent>
            </Card>
          ) : filteredCompleted.length === 0 ? (
            searchQuery ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Mic className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
                  <h3 className="text-lg font-medium mb-2">検索結果がありません</h3>
                  <p className="text-muted-foreground text-sm">別のキーワードで試してください</p>
                </CardContent>
              </Card>
            ) : (
              <OnboardingEmptyState />
            )
          ) : (
            <div className="space-y-3">
              {filteredCompleted.map((meeting) => (
                <Card
                  key={meeting.id}
                  className={`transition-colors cursor-pointer hover:border-primary/50 ${
                    selectionMode ? "" : "hover:shadow-md"
                  } ${selectedIds.has(meeting.id) ? "border-primary bg-primary/5" : ""}`}
                  onClick={() => {
                    if (selectionMode) {
                      toggleSelect(meeting.id);
                    } else if (renamingId !== meeting.id) {
                      navigate(`/meetings/${meeting.id}`);
                    }
                  }}
                >
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        {selectionMode && (
                          <div className="mt-0.5 shrink-0">
                            {selectedIds.has(meeting.id) ? (
                              <CheckSquare className="w-4 h-4 text-primary" />
                            ) : (
                              <Square className="w-4 h-4 text-muted-foreground" />
                            )}
                          </div>
                        )}
                        <div className="w-8 h-8 rounded bg-secondary flex items-center justify-center shrink-0 text-sm font-medium">
                          {getPlatformIcon(meeting.platform)}
                        </div>
                        <div className="min-w-0 flex-1">
                          {renamingId === meeting.id ? (
                            <InlineRename
                              meetingId={meeting.id}
                              currentTitle={meeting.title}
                              onDone={() => setRenamingId(null)}
                            />
                          ) : (
                            <div className="flex items-center gap-1 group">
                              <p className="font-medium hover:text-primary transition-colors truncate">
                                {meeting.title}
                              </p>
                              {!selectionMode && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRenamingId(meeting.id); }}
                                >
                                  <Pencil className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {formatDate(meeting.startedAt)}
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatDuration(meeting.duration)}
                            </span>
                          </div>
                        </div>
                      </div>
                      {!selectionMode && (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const ok = await confirm({
                                title: "この会議を削除しますか？",
                                description: "削除すると元に戻せません。",
                                confirmText: "削除する",
                                destructive: true,
                              });
                              if (ok) deleteMutation.mutate(meeting.id);
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
