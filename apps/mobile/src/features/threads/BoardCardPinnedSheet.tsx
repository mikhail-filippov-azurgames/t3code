import { clearBoardCardMentionCache } from "@t3tools/client-runtime/board-card-mentions";
import type {
  BoardCard,
  BoardCardLookupDetail,
  BoardCardStatus,
  BoardExecutorRole,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { BoardCardId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { boardEnvironment } from "../../state/board";
import { useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

interface BoardCardPinnedSheetProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cardIds: ReadonlyArray<string>;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onRemove: (cardId: string) => void;
  readonly onUpdated?: () => void;
}

const BOARD_STATUS_LABELS: Readonly<Record<BoardCardStatus, string>> = {
  todo: "К выполнению",
  orchestrator: "Оркестратор",
  in_progress: "В работе",
  review: "На проверке",
  done: "Готово",
};

const BOARD_EXECUTOR_ROLE_LABELS: Readonly<Record<BoardExecutorRole, string>> = {
  architecture: "Архитектура",
  implementation: "Реализация",
  review: "Проверка",
  test: "Тестирование",
  research: "Исследование",
  general: "Общая задача",
};

function boardStatusLabel(status: BoardCardStatus): string {
  return BOARD_STATUS_LABELS[status];
}

function boardExecutorRoleLabel(role: BoardExecutorRole): string {
  return BOARD_EXECUTOR_ROLE_LABELS[role];
}

function splitCardIds(cardIds: ReadonlyArray<string>, size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < cardIds.length; index += size) {
    chunks.push(cardIds.slice(index, index + size));
  }
  return chunks;
}

export function BoardCardPinnedSheet(props: BoardCardPinnedSheetProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const shells = useThreadShells();
  const resolveCards = useAtomQueryRunner(boardEnvironment.resolve, {
    reportFailure: false,
    refresh: true,
  });
  const startCard = useAtomCommand(boardEnvironment.start, { reportFailure: false });
  const updateCard = useAtomCommand(boardEnvironment.update, { reportFailure: false });
  const requestOrchestrator = useAtomCommand(boardEnvironment.requestOrchestrator, {
    reportFailure: false,
  });
  const [details, setDetails] = useState<ReadonlyMap<string, BoardCardLookupDetail>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const loadDetails = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setDetails(new Map());
    setLoadError(false);
    setActionError(null);
    if (props.cardIds.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const loaded = new Map<string, BoardCardLookupDetail>();
      for (const chunk of splitCardIds(props.cardIds, 20)) {
        const result = await resolveCards({
          environmentId: props.environmentId,
          input: {
            tokens: [],
            cardIds: chunk.map((cardId) => BoardCardId.make(cardId)),
          },
        });
        if (!AsyncResult.isSuccess(result)) throw result.cause;
        for (const detail of result.value.details) {
          loaded.set(String(detail.card.cardId), detail);
        }
      }
      if (sequence === loadSequence.current) setDetails(loaded);
    } catch {
      if (sequence === loadSequence.current) {
        setDetails(new Map());
        setLoadError(true);
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [props.cardIds, props.environmentId, resolveCards]);

  useEffect(() => {
    void loadDetails();
    return () => {
      loadSequence.current += 1;
    };
  }, [loadDetails]);

  const openThread = useCallback(
    (threadId: ThreadId) => {
      void navigation.navigate("Thread", {
        environmentId: String(props.environmentId),
        threadId: String(threadId),
      });
    },
    [navigation, props.environmentId],
  );

  const start = useCallback(
    async (card: BoardCard) => {
      const cardId = String(card.cardId);
      setBusyCardId(cardId);
      setActionError(null);
      const result = await startCard({
        environmentId: props.environmentId,
        input: { cardId: card.cardId },
      });
      setBusyCardId(null);
      if (!AsyncResult.isSuccess(result)) {
        setActionError(boardActionFailureText(result.cause));
        return;
      }
      clearBoardCardMentionCache(String(props.environmentId));
      await loadDetails();
      props.onUpdated?.();
    },
    [loadDetails, props, startCard],
  );

  const toggleArchive = useCallback(
    async (card: BoardCard) => {
      const cardId = String(card.cardId);
      setBusyCardId(cardId);
      setActionError(null);
      const result = await updateCard({
        environmentId: props.environmentId,
        input: { cardId: card.cardId, archived: !card.archived },
      });
      setBusyCardId(null);
      if (!AsyncResult.isSuccess(result)) {
        setActionError(boardActionFailureText(result.cause));
        return;
      }
      clearBoardCardMentionCache(String(props.environmentId));
      await loadDetails();
      props.onUpdated?.();
    },
    [loadDetails, props, updateCard],
  );

  const request = useCallback(
    async (card: BoardCard, text: string) => {
      const ownerShell = shells.find(
        (shell) =>
          shell.environmentId === props.environmentId && shell.id === card.orchestratorThreadId,
      );
      if (!ownerShell) {
        setActionError("Чат оркестратора недоступен. Проверьте соединение и повторите запрос.");
        return;
      }
      const cardId = String(card.cardId);
      setBusyCardId(cardId);
      setActionError(null);
      const result = await requestOrchestrator({
        environmentId: props.environmentId,
        input: {
          threadId: card.orchestratorThreadId,
          text,
          modelSelection: ownerShell.modelSelection,
          runtimeMode: ownerShell.runtimeMode,
          interactionMode: ownerShell.interactionMode,
        },
      });
      setBusyCardId(null);
      if (!AsyncResult.isSuccess(result)) {
        setActionError(boardActionFailureText(result.cause));
        return;
      }
      setActionError("Просьба отправлена оркестратору.");
    },
    [props.environmentId, requestOrchestrator, shells],
  );

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      <View className="flex-1 justify-end bg-black/45">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Закрыть карточки доски"
          className="absolute inset-0"
          onPress={props.onClose}
        />
        <View
          className="max-h-[84%] rounded-t-3xl border border-border bg-screen px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="font-t3-bold text-lg text-foreground">Карточки доски</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Обновить карточки доски"
              disabled={loading}
              className="min-h-10 min-w-10 items-center justify-center rounded-full active:opacity-60"
              onPress={() => void loadDetails()}
            >
              <Text className="font-t3-bold text-sm text-primary">
                {loading ? "Загрузка…" : "Обновить"}
              </Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-3 pb-4"
            style={{ flexGrow: 0 }}
          >
            {loading ? (
              <View className="flex-row items-center gap-2 py-2">
                <ActivityIndicator />
                <Text className="text-sm text-foreground-secondary">Загрузка карточек…</Text>
              </View>
            ) : null}
            {loadError ? (
              <View accessibilityRole="alert" className="gap-2 rounded-xl bg-destructive/10 p-3">
                <Text className="text-sm text-foreground">
                  Не удалось загрузить карточку. Проверьте соединение и повторите запрос.
                </Text>
                <BoardCardButton label="Повторить" onPress={() => void loadDetails()} />
              </View>
            ) : null}
            {props.cardIds.map((cardId) => {
              const detail = details.get(cardId);
              return (
                <BoardCardPinnedItem
                  key={cardId}
                  cardId={cardId}
                  detail={detail}
                  loading={loading}
                  loadError={loadError}
                  actionError={actionError}
                  busy={busyCardId === cardId}
                  onRemove={() => props.onRemove(cardId)}
                  onOpenThread={openThread}
                  onStart={start}
                  onToggleArchive={toggleArchive}
                  onRequest={request}
                  onRetry={() => void loadDetails()}
                />
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function BoardCardPinnedItem(props: {
  readonly cardId: string;
  readonly detail: BoardCardLookupDetail | undefined;
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly actionError: string | null;
  readonly busy: boolean;
  readonly onRemove: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStart: (card: BoardCard) => void;
  readonly onToggleArchive: (card: BoardCard) => void;
  readonly onRequest: (card: BoardCard, text: string) => Promise<void>;
  readonly onRetry: () => void;
}) {
  const [requestText, setRequestText] = useState("");
  const { card, events, orchestratorThreadTitle } = props.detail ?? {};
  return (
    <View className="rounded-2xl border border-border bg-card p-3">
      <View className="mb-2 flex-row items-start gap-2">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-bold text-base text-foreground">
            {card?.title ?? props.cardId}
          </Text>
          {card ? (
            <Text className="mt-1 text-xs text-foreground-secondary">
              {boardStatusLabel(card.status)} · {boardExecutorRoleLabel(card.executorRole)} ·{" "}
              {card.archived ? "архив" : "активна"}
            </Text>
          ) : null}
        </View>
        <BoardCardButton label="Снять" onPress={props.onRemove} />
      </View>
      {props.loadError ? (
        <View className="gap-2 rounded-xl bg-destructive/10 p-3">
          <Text className="text-sm text-foreground">
            Не удалось загрузить карточку. Проверьте соединение и повторите запрос.
          </Text>
          <BoardCardButton label="Повторить" onPress={props.onRetry} />
        </View>
      ) : null}
      {!props.loading && !props.loadError && !props.detail ? (
        <Text className="text-sm text-foreground-secondary">
          Карточка недоступна: она могла быть удалена.
        </Text>
      ) : null}
      {card && props.detail ? (
        <>
          <Text className="mb-3 text-xs text-foreground-secondary">
            Оркестратор: {orchestratorThreadTitle ?? String(card.orchestratorThreadId)}
          </Text>
          {card.body ? (
            <Text className="mb-3 text-sm leading-normal text-foreground">{card.body}</Text>
          ) : null}
          <View className="mb-3 flex-row flex-wrap gap-2">
            <BoardCardButton
              label="Чат оркестратора"
              onPress={() => props.onOpenThread(card.orchestratorThreadId)}
            />
            {card.executorThreadId ? (
              <BoardCardButton
                label="Чат исполнителя"
                onPress={() => props.onOpenThread(card.executorThreadId!)}
              />
            ) : null}
            {card.status === "todo" && !card.archived ? (
              <BoardCardButton
                label="Запустить"
                disabled={props.busy}
                onPress={() => props.onStart(card)}
              />
            ) : null}
            <BoardCardButton
              label={card.archived ? "Разархивировать" : "Архивировать"}
              disabled={props.busy}
              onPress={() => props.onToggleArchive(card)}
            />
          </View>
          <Text className="mb-1 text-xs font-semibold text-foreground">Просьба оркестратору</Text>
          <TextInput
            accessibilityLabel="Просьба оркестратору"
            className="mb-2 min-h-20 rounded-xl border border-border bg-screen px-3 py-2 text-sm text-foreground"
            multiline
            textAlignVertical="top"
            value={requestText}
            onChangeText={setRequestText}
            placeholder="Напишите, что нужно проверить или уточнить"
            placeholderTextColor="#888888"
          />
          <BoardCardButton
            label="Отправить просьбу"
            disabled={props.busy || requestText.trim().length === 0}
            onPress={() => {
              const text = requestText.trim();
              if (text) void props.onRequest(card, text);
            }}
          />
          {props.actionError ? (
            <Text className="mt-2 text-xs text-foreground-secondary">{props.actionError}</Text>
          ) : null}
          <View className="mt-3 border-t border-border pt-2">
            <Text className="mb-2 font-t3-bold text-sm text-foreground">История</Text>
            {events?.length ? (
              events.map((event) => (
                <View key={event.entryId} className="mb-2 border-l-2 border-border pl-2">
                  <Text className="text-xs font-semibold text-foreground">
                    {boardStatusLabel(event.status)} · {boardExecutorRoleLabel(event.executorRole)}
                  </Text>
                  {event.body ? (
                    <Text className="text-xs text-foreground-secondary">{event.body}</Text>
                  ) : null}
                  <Text className="text-[10px] text-foreground-muted">
                    {new Date(event.at).toLocaleString()}
                  </Text>
                </View>
              ))
            ) : (
              <Text className="text-xs text-foreground-secondary">История пуста.</Text>
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

function BoardCardButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      className="min-h-10 justify-center rounded-xl border border-border bg-screen px-3 active:opacity-60 disabled:opacity-45"
      onPress={props.onPress}
    >
      <Text className="font-t3-bold text-xs text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function boardActionFailureText(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return "Не удалось выполнить действие с карточкой.";
}
