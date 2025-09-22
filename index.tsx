/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
  useState,
  useEffect,
  FormEvent,
  useCallback,
  DragEvent,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// --- TYPES AND CONSTANTS ---

// Matrix A (Eisenhower)
type QuadrantKeyA = "Q1" | "Q2" | "Q3" | "Q4";
interface QuadrantA {
  id: QuadrantKeyA;
  title: string;
  label: string;
}
const QUADRANTS_A: QuadrantA[] = [
  { id: "Q1", title: "🔥 重要かつ緊急", label: "すぐやる" },
  { id: "Q2", title: "📅 重要だが緊急でない", label: "計画する" },
  { id: "Q3", title: "🤝 緊急だが重要でない", label: "任せる" },
  { id: "Q4", title: "🗑️ 重要でも緊急でもない", label: "やめる" },
];

// Matrix B (Want/Required)
type QuadrantKeyB = "R1" | "R2" | "R3" | "R4";
interface QuadrantB {
  id: QuadrantKeyB;
  title: string;
  label: string;
}
const QUADRANTS_B: QuadrantB[] = [
  { id: "R1", title: "🌟 やりたい × 求められる", label: "強み・価値になること" },
  { id: "R2", title: "💭 やりたい × 求められない", label: "夢・趣味の領域" },
  { id: "R3", title: "🆘 やりたくない × 求められる", label: "義務・サポート依頼" },
  { id: "R4", title: "🗑️ やりたくない × 求められない", label: "切り捨て候補" },
];

// Matrix C (Want/Can)
type QuadrantKeyC = "S1" | "S2" | "S3" | "S4";
interface QuadrantC {
  id: QuadrantKeyC;
  title: string;
  label: string;
}
const QUADRANTS_C: QuadrantC[] = [
  { id: "S1", title: "💪 やりたい × できる", label: "得意・情熱" },
  { id: "S2", title: "🌱 やりたい × できない", label: "挑戦・学習" },
  { id: "S3", title: "タスク やりたくない × できる", label: "義務・作業" },
  { id: "S4", title: "🗑️ やりたくない × できない", label: "手放す候補" },
];

type AnyQuadrantKey = QuadrantKeyA | QuadrantKeyB | QuadrantKeyC;
type ActiveMatrix = "A" | "B" | "C";

interface Task {
  id: string;
  text: string;
  completed: boolean;
  quadrants: {
    A: QuadrantKeyA;
    B: QuadrantKeyB;
    C: QuadrantKeyC;
  };
}

type TaskCache = Record<string, { A: QuadrantKeyA; B: QuadrantKeyB; C: QuadrantKeyC }>;

// --- DECOMPOSITION MODAL COMPONENT ---

interface DecompositionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (selectedSubTasks: string[]) => void;
    task: Task | null;
    subTasks: string[];
    isLoading: boolean;
}

const DecompositionModal: React.FC<DecompositionModalProps> = ({
    isOpen, onClose, onAdd, task, subTasks, isLoading,
}) => {
    const [selectedSubTasks, setSelectedSubTasks] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setSelectedSubTasks(subTasks);
        }
    }, [isOpen, subTasks]);

    if (!isOpen || !task) return null;

    const handleCheckboxChange = (subTask: string) => {
        setSelectedSubTasks(prev =>
            prev.includes(subTask)
                ? prev.filter(t => t !== subTask)
                : [...prev, subTask]
        );
    };

    const handleAddClick = () => {
        onAdd(selectedSubTasks);
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>「{task.text}」を分解</h3>
                    <button className="close-btn" onClick={onClose} aria-label="閉じる">&times;</button>
                </div>
                <div className="modal-body">
                    {isLoading ? (
                        <div className="modal-loader-container">
                            <div className="loader"></div>
                            <p>AIがタスクを分解中です...</p>
                        </div>
                    ) : subTasks.length > 0 ? (
                        <>
                            <p>追加したいサブタスクを選択してください：</p>
                            <ul className="subtask-list">
                                {subTasks.map((subTask, index) => (
                                    <li key={index} className="subtask-item">
                                        <input
                                            type="checkbox"
                                            id={`subtask-${index}`}
                                            checked={selectedSubTasks.includes(subTask)}
                                            onChange={() => handleCheckboxChange(subTask)}
                                        />
                                        <label htmlFor={`subtask-${index}`}>{subTask}</label>
                                    </li>
                                ))}
                            </ul>
                        </>
                    ) : (
                        <p>サブタスクを生成できませんでした。</p>
                    )}
                </div>
                <div className="modal-footer">
                    <button className="modal-btn-secondary" onClick={onClose}>キャンセル</button>
                    <button
                        className="modal-btn-primary"
                        onClick={handleAddClick}
                        disabled={isLoading || selectedSubTasks.length === 0}
                    >
                        選択したタスクを追加
                    </button>
                </div>
            </div>
        </div>
    );
};


const App: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeMatrix, setActiveMatrix] = useState<ActiveMatrix>("A");
  const [newTask, setNewTask] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOverQuadrant, setDragOverQuadrant] = useState<AnyQuadrantKey | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<{ taskText: string; reason: string } | null>(null);

  // --- BATCHING & CACHING STATE ---
  const [cache, setCache] = useState<TaskCache>({});
  const [taskQueue, setTaskQueue] = useState<string[]>([]);
  const batchTimerRef = useRef<number | null>(null);

  // --- DECOMPOSITION STATE ---
  const [isDecompositionModalOpen, setIsDecompositionModalOpen] = useState(false);
  const [taskToDecompose, setTaskToDecompose] = useState<Task | null>(null);
  const [decomposedSubTasks, setDecomposedSubTasks] = useState<string[]>([]);
  const [isDecomposing, setIsDecomposing] = useState(false);

  // --- FOCUS TIMER STATE ---
  const [focusingTaskId, setFocusingTaskId] = useState<string | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const timerIntervalRef = useRef<number | null>(null);

  // --- DATA PERSISTENCE ---

  const migrateTasks = (tasksToMigrate: any[]): Task[] => {
    return tasksToMigrate.map(task => ({
        ...task,
        completed: task.completed ?? false,
    }));
  };

  // Load tasks from URL/LocalStorage on mount
  useEffect(() => {
    try {
      if (window.location.hash.length > 1) {
        const encodedData = window.location.hash.substring(1);
        const decodedData = atob(encodedData);
        const parsedTasks = JSON.parse(decodedData);
        if (Array.isArray(parsedTasks)) {
          setTasks(migrateTasks(parsedTasks));
          return;
        }
      }
      const savedTasks = localStorage.getItem("triMatrixTasks");
      if (savedTasks) {
        setTasks(migrateTasks(JSON.parse(savedTasks)));
      }
    } catch (e) {
      console.error("Failed to load tasks", e);
    }
  }, []);

  // Save tasks to URL/LocalStorage on change
  useEffect(() => {
    try {
      const jsonTasks = JSON.stringify(tasks);
      localStorage.setItem("triMatrixTasks", jsonTasks);
      if (tasks.length > 0) {
        const encodedData = btoa(jsonTasks);
        window.history.replaceState(null, "", "#" + encodedData);
      } else {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    } catch (e) {
      console.error("Failed to save tasks", e);
    }
  }, [tasks]);

  // Load cache from LocalStorage on mount
  useEffect(() => {
    try {
        const savedCache = localStorage.getItem("triMatrixTaskCache");
        if (savedCache) {
            setCache(JSON.parse(savedCache));
        }
    } catch (e) {
        console.error("Failed to load cache", e);
    }
  }, []);

  // Save cache to LocalStorage on change
  useEffect(() => {
    try {
        localStorage.setItem("triMatrixTaskCache", JSON.stringify(cache));
    } catch (e) {
        console.error("Failed to save cache", e);
    }
  }, [cache]);

  // --- FOCUS TIMER EFFECT ---
  useEffect(() => {
    if (isTimerRunning && timerSeconds > 0) {
        timerIntervalRef.current = window.setInterval(() => {
            setTimerSeconds(prev => prev - 1);
        }, 1000);
    } else if (timerSeconds === 0 && isTimerRunning) {
        setIsTimerRunning(false);
        setFocusingTaskId(null);
        alert('集中タイム終了！お疲れ様でした。少し休憩しましょう。');
    }
    return () => {
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
        }
    };
}, [isTimerRunning, timerSeconds]);

  // --- AI BATCH CLASSIFICATION ---
  const classifyAndAddTasks = useCallback(async (tasksToProcess: string[]) => {
    if (tasksToProcess.length === 0) return;

    setIsLoading(true);
    setError(null);
    setAiSuggestion(null);

    const prompt = `以下のタスクリストを、3つの異なるマトリクス（A, B, C）に基づいて分類してください。
結果は必ず指示されたJSONスキーマに従うJSONオブジェクトで返してください。タスクリストに含まれるすべてのタスクを分類に含める必要があります。

マトリクスA (重要×緊急): Q1(重要かつ緊急), Q2(重要だが緊急でない), Q3(緊急だが重要でない), Q4(重要でも緊急でもない)
マトリクスB (やりたい×求められる): R1(やりたい×求められる), R2(やりたい×求められない), R3(やりたくない×求められる), R4(やりたくない×求められない)
マトリクスC (やりたい×できる): S1(やりたい×できる), S2(やりたい×できない), S3(やりたくない×できる), S4(やりたくない×できない)

タスクリスト:
${tasksToProcess.map((t) => `- ${t}`).join("\n")}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              classifications: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    task: {
                      type: Type.STRING,
                      description: "分類された元のタスクのテキスト。",
                    },
                    quadrants: {
                      type: Type.OBJECT,
                      properties: {
                        A: { type: Type.STRING, description: "マトリクスAの分類結果 (Q1-Q4)。" },
                        B: { type: Type.STRING, description: "マトリクスBの分類結果 (R1-R4)。" },
                        C: { type: Type.STRING, description: "マトリクスCの分類結果 (S1-S4)。" },
                      },
                      required: ["A", "B", "C"],
                    },
                  },
                  required: ["task", "quadrants"],
                },
              },
            },
            required: ["classifications"],
          },
        },
      });

      const result = JSON.parse(response.text);
      const classifiedTasks: Task[] = [];
      const newCacheEntries: TaskCache = {};

      const validA = new Set(QUADRANTS_A.map((q) => q.id));
      const validB = new Set(QUADRANTS_B.map((q) => q.id));
      const validC = new Set(QUADRANTS_C.map((q) => q.id));

      for (const item of result.classifications) {
        const taskText = item.task;
        const { A, B, C } = item.quadrants;

        if (tasksToProcess.includes(taskText) && validA.has(A) && validB.has(B) && validC.has(C)) {
          const quadrants = { A, B, C };
          classifiedTasks.push({
            id: `${Date.now()}-${Math.random()}`,
            text: taskText,
            completed: false,
            quadrants,
          });
          newCacheEntries[taskText] = quadrants;
        } else {
          console.warn(`Invalid classification for task: ${taskText}`, item.quadrants);
        }
      }

      setTasks((prev) => [...prev, ...classifiedTasks]);
      setCache((prev) => ({ ...prev, ...newCacheEntries }));
    } catch (e) {
      console.error("Error classifying task batch:", e);
      setError("タスクを一括で分類できませんでした。もう一度お試しください。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // --- BATCH PROCESSING EFFECT ---
  useEffect(() => {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
    }

    if (taskQueue.length > 0) {
      batchTimerRef.current = window.setTimeout(() => {
        classifyAndAddTasks([...taskQueue]);
        setTaskQueue([]);
      }, 1500); // Debounce time: 1.5 seconds
    }

    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
      }
    };
  }, [taskQueue, classifyAndAddTasks]);

  // --- TASK MANAGEMENT HANDLERS ---
  const handleAddTask = (e: FormEvent) => {
    e.preventDefault();
    const taskText = newTask.trim();
    if (!taskText) return;

    setAiSuggestion(null);

    // 1. Check cache
    const cachedResult = cache[taskText];
    if (cachedResult) {
      setTasks((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          text: taskText,
          completed: false,
          quadrants: cachedResult,
        },
      ]);
      setNewTask("");
      return;
    }

    // 2. Add to queue if not cached and not already in queue
    if (!taskQueue.includes(taskText)) {
      setTaskQueue((prev) => [...prev, taskText]);
    }
    setNewTask("");
  };

  const handleDeleteTask = (taskId: string) => {
    setTasks((prevTasks) => prevTasks.filter((task) => task.id !== taskId));
    setAiSuggestion(null);
  };
  
  const handleToggleComplete = (taskId: string) => {
    setTasks(prevTasks =>
        prevTasks.map(task =>
            task.id === taskId ? { ...task, completed: !task.completed } : task
        )
    );
    setAiSuggestion(null);
  };

  const handleClearCompleted = () => {
    if (window.confirm("完了済みのタスクをすべて削除しますか？")) {
        setTasks(prevTasks => prevTasks.filter(task => !task.completed));
        setAiSuggestion(null);
    }
  };


  const handleGetSuggestion = async () => {
    const activeTasks = tasks.filter(task => !task.completed);
    if (activeTasks.length === 0) {
        setError("完了すべきアクティブなタスクがありません。");
        return;
    }

    setIsSuggesting(true);
    setError(null);
    setAiSuggestion(null);

    const prompt = `あなたは優秀な生産性向上コーチです。
以下は、あるユーザーのタスクリストです。各タスクは3つの異なるマトリクス（A: 重要×緊急, B: やりたい×求められる, C: やりたい×できる）で分類されています。
このリストの中から、ユーザーが次に着手すべきタスクを1つだけ選び、そのタスクに取り組むべき理由を簡潔に、やる気の出るような言葉で説明してください。
タスクリスト:
${JSON.stringify(activeTasks, null, 2)}`;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        taskText: {
                            type: Type.STRING,
                            description: "選んだタスクのテキスト",
                        },
                        reason: {
                            type: Type.STRING,
                            description: "そのタスクを推奨する理由",
                        },
                    },
                    required: ["taskText", "reason"],
                },
            },
        });
        const result = JSON.parse(response.text);
        setAiSuggestion(result);
    } catch (e) {
        console.error("Error getting suggestion:", e);
        setError("AIからのおすすめを取得できませんでした。もう一度お試しください。");
    } finally {
        setIsSuggesting(false);
    }
  };

  // --- DECOMPOSITION HANDLERS ---
    const handleOpenDecompositionModal = async (task: Task) => {
        setTaskToDecompose(task);
        setIsDecompositionModalOpen(true);
        setIsDecomposing(true);
        setDecomposedSubTasks([]);
        setError(null);

        const prompt = `あなたは優秀なプロジェクトマネージャーです。
以下のタスクを、具体的で実行可能な3〜5個のサブタスクに分解してください。
結果は指示されたJSONスキーマに従ってください。

分解するタスク: "${task.text}"`;

        try {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            subTasks: {
                                type: Type.ARRAY,
                                items: { type: Type.STRING },
                                description: "分解されたサブタスクのリスト（3〜5個）",
                            },
                        },
                        required: ["subTasks"],
                    },
                },
            });
            const result = JSON.parse(response.text);
            setDecomposedSubTasks(result.subTasks || []);
        } catch (e) {
            console.error("Error decomposing task:", e);
            setError("タスクの分解に失敗しました。もう一度お試しください。");
            // Don't close modal on error, let user see the message
        } finally {
            setIsDecomposing(false);
        }
    };

    const handleCloseDecompositionModal = () => {
        setIsDecompositionModalOpen(false);
        setTaskToDecompose(null);
        setDecomposedSubTasks([]);
        setIsDecomposing(false);
    };

    const handleAddSelectedSubTasks = (selectedSubTasks: string[]) => {
        // Add new sub-tasks to the processing queue
        const newTasksToQueue = selectedSubTasks.filter(t => !taskQueue.includes(t));
        if (newTasksToQueue.length > 0) {
            setTaskQueue(prev => [...prev, ...newTasksToQueue]);
        }

        // Delete the original, large task
        if (taskToDecompose) {
            handleDeleteTask(taskToDecompose.id);
        }

        handleCloseDecompositionModal();
    };

    // --- FOCUS TIMER HANDLERS ---
    const handleStartFocus = (taskId: string) => {
      setFocusingTaskId(taskId);
      setTimerSeconds(25 * 60); // 25 minutes
      setIsTimerRunning(true);
    };

    const handleStopFocus = () => {
      if (window.confirm('集中タイマーを停止しますか？')) {
        setIsTimerRunning(false);
        setFocusingTaskId(null);
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
        }
      }
    };

  // --- DRAG & DROP HANDLERS ---
  const handleDragStart = useCallback((e: DragEvent<HTMLLIElement>, taskId: string) => {
    e.dataTransfer.setData("taskId", taskId);
    e.currentTarget.classList.add("dragging");
  }, []);

  const handleDragEnd = useCallback((e: DragEvent<HTMLLIElement>) => {
    e.currentTarget.classList.remove("dragging");
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLElement>, quadrantId: AnyQuadrantKey) => {
    e.preventDefault();
    setDragOverQuadrant(quadrantId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverQuadrant(null);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLElement>, newQuadrantId: AnyQuadrantKey) => {
      e.preventDefault();
      setDragOverQuadrant(null);
      const taskId = e.dataTransfer.getData("taskId");
      if (!taskId) return;

      setTasks((prevTasks) =>
        prevTasks.map((task) => {
          if (task.id === taskId) {
            const updatedQuadrants = { ...task.quadrants };
            switch (activeMatrix) {
              case "A":
                updatedQuadrants.A = newQuadrantId as QuadrantKeyA;
                break;
              case "B":
                updatedQuadrants.B = newQuadrantId as QuadrantKeyB;
                break;
              case "C":
                updatedQuadrants.C = newQuadrantId as QuadrantKeyC;
                break;
            }
            return { ...task, quadrants: updatedQuadrants };
          }
          return task;
        })
      );
      setAiSuggestion(null);
    },
    [activeMatrix]
  );

  // --- RENDERING ---
  const completedTasksCount = tasks.filter(task => task.completed).length;
  const totalTasksCount = tasks.length;
  const progressPercentage = totalTasksCount > 0 ? Math.round((completedTasksCount / totalTasksCount) * 100) : 0;
  const hasCompletedTasks = completedTasksCount > 0;
  const activeTasksCount = totalTasksCount - completedTasksCount;

  const focusingTask = tasks.find(task => task.id === focusingTaskId);

  const renderMatrix = (matrixType: ActiveMatrix) => {
    const quadrants =
      matrixType === "A" ? QUADRANTS_A : matrixType === "B" ? QUADRANTS_B : QUADRANTS_C;
    return (
      <div className={`matrix-container matrix-${matrixType.toLowerCase()}`}>
        {quadrants.map(({ id, title, label }) => {
          const quadrantTasks = tasks.filter(
            (task) => task.quadrants[matrixType] === id
          );
          return (
            <section
              key={id}
              id={id.toLowerCase()}
              className={`quadrant ${dragOverQuadrant === id ? "drag-over" : ""}`}
              aria-labelledby={`${id}-heading`}
              onDragOver={(e) => handleDragOver(e, id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, id)}
            >
              <h2 id={`${id}-heading`}>{title}</h2>
              <p className="quadrant-label">{label}</p>
              <ul className="task-list">
                {quadrantTasks.map((task) => (
                  <li
                    key={task.id}
                    className={`task-item ${task.completed ? 'completed' : ''} ${focusingTaskId && focusingTaskId === task.id ? 'is-focused' : ''} ${focusingTaskId && focusingTaskId !== task.id ? 'is-unfocused' : ''}`}
                    draggable={!isTimerRunning}
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    onDragEnd={handleDragEnd}
                  >
                    <input 
                      type="checkbox"
                      className="task-checkbox"
                      checked={task.completed}
                      onChange={() => handleToggleComplete(task.id)}
                      aria-label={`タスクを完了にする: ${task.text}`}
                    />
                    <span>{task.text}</span>
                    <div className="task-actions">
                      {!isTimerRunning && (
                         <button
                            className="icon-btn focus-btn"
                            onClick={() => handleStartFocus(task.id)}
                            aria-label={`このタスクに集中: ${task.text}`}
                            title="このタスクに集中"
                         >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                              <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                            </svg>
                         </button>
                      )}
                      <button
                        className="icon-btn decompose-btn"
                        onClick={() => handleOpenDecompositionModal(task)}
                        aria-label={`AIでタスクを分解: ${task.text}`}
                        title="AIでタスクを分解"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                          <path fillRule="evenodd" d="M10.868 2.884c.321.242.592.558.797.907l.56 1.007c.228.41.66.685 1.144.719l1.09.076c.498.034.958.26 1.303.628.344.368.528.85.528 1.353l-.001.272c-.002.502-.213.974-.558 1.32l-.76.76c-.344.344-.555.82-.555 1.321l.001.272c.001.503.184.985.528 1.353.345.368.805.594 1.303.628l1.09.076c.484.034.916.31 1.144.719l.56 1.007c.205.35.476.665.797.907.322.242.703.379 1.1.379.482 0 .943-.234 1.234-.64.292-.405.412-.916.32-1.425l-.273-1.542c-.15-.849-.785-1.53-1.639-1.66l-1.09-.164a.89.89 0 01-.734-.889l.001-.272c.002-.501.213-.973.557-1.32l.76-.76c.345-.346.556-.819.558-1.321l.001-.272c0-.503-.184-.985-.528-1.353a1.89 1.89 0 00-1.303-.628l-1.09-.076a1.89 1.89 0 01-1.144-.719l-.56-1.007a1.89 1.89 0 00-.797-.907c-.321-.242-.702-.38-1.1-.38-.482 0-.943.234-1.234.64-.292.405-.412.916-.32 1.425l.273 1.542c.15.848.785 1.53 1.639 1.66l1.09.164c.277.042.51.18.665.391.156.21.234.468.234.734l-.001.272zM5.152 2.21c.482 0 .943.234 1.234.64.292.405.412.916.32 1.425l-.273 1.542c-.15.849-.785 1.53-1.639 1.66l-1.09.164c-.484.072-.89.417-.962.889l-.001.272c-.002.501.213.973.557 1.32l.76.76c.345.346.556.819.558 1.321l.001.272c0 .503-.184.985-.528 1.353a1.89 1.89 0 00-1.303-.628l-1.09-.076a1.89 1.89 0 01-1.144-.719l-.56-1.007a1.89 1.89 0 00-.797-.907 1.89 1.89 0 00-1.1-.38c-.482 0-.943.234-1.234.64-.292.405-.412.916-.32 1.425l.273 1.542c.15.848.785 1.53 1.639 1.66l1.09.164c.484.072.89.417.962.889l.001.272c.002.502-.213.974-.558 1.32l-.76.76c-.344.344-.555.82-.555 1.321l.001.272c.001.503.184.985.528 1.353.345.368.805.594 1.303.628l1.09.076c.484.034.916.31 1.144.719l.56 1.007c.205.35.476.665.797.907.322.242.703.379 1.1.379.482 0 .943-.234 1.234-.64.292-.405-.412-.916-.32-1.425l-.273-1.542c-.15-.849-.785-1.53-1.639-1.66l-1.09-.164a.89.89 0 01-.734-.889l.001-.272c.002-.501.213-.973.557-1.32l.76-.76c.345-.346.556-.819.558-1.321l.001-.272c0-.503-.184-.985-.528-1.353a1.89 1.89 0 00-1.303-.628l-1.09-.076a1.89 1.89 0 01-1.144-.719l-.56-1.007a1.89 1.89 0 00-.797-.907c-.321-.242-.702-.38-1.1-.38z" clipRule="evenodd" />
                        </svg>
                      </button>
                      <button
                        className="icon-btn delete-btn"
                        onClick={() => handleDeleteTask(task.id)}
                        aria-label={`タスクを削除: ${task.text}`}
                        title="タスクを削除"
                      >
                        &times;
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {isTimerRunning && focusingTask && (
        <div className="focus-timer-bar">
          <div className="focus-timer-content">
            <p>
              <strong>集中中のタスク:</strong> {focusingTask.text}
            </p>
            <span className="timer-display" aria-live="polite">
              {Math.floor(timerSeconds / 60)}:{('0' + (timerSeconds % 60)).slice(-2)}
            </span>
            <button onClick={handleStopFocus} className="stop-focus-btn">停止</button>
          </div>
        </div>
      )}
      <header>
        <h1>夢を実現するための日常管理ツール</h1>
        <p>AIによる多角的なタスク分析で、あなたの「やりたいこと」を明確に。</p>
      </header>
      <main>
        <div className="task-entry-section">
          <form className="task-form" onSubmit={handleAddTask}>
            <input
              type="text"
              className="task-input"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              placeholder="例：歯医者の予約を入れる"
              aria-label="新規タスク"
              disabled={isLoading || isTimerRunning}
            />
            <button type="submit" className="add-task-btn" disabled={isLoading || !newTask.trim() || isTimerRunning}>
              {isLoading ? (
                <div className="loader"></div>
              ) : taskQueue.length > 0 ? (
                `分類待ち(${taskQueue.length})`
              ) : (
                "追加"
              )}
            </button>
          </form>
          <div className="ai-actions">
            {hasCompletedTasks && (
                <button
                    onClick={handleClearCompleted}
                    className="ai-action-btn clear-btn"
                    title="完了済みのタスクをすべて削除します"
                    disabled={isTimerRunning}
                >
                    完了済みを削除
                </button>
            )}
            <button
                onClick={handleGetSuggestion}
                className="ai-action-btn"
                disabled={isSuggesting || activeTasksCount === 0 || isTimerRunning}
            >
                {isSuggesting ? (
                    <div className="loader"></div>
                ) : (
                    "✨ AIに次のおすすめを聞く"
                )}
            </button>
          </div>
        </div>

        {totalTasksCount > 0 && (
            <div className="progress-section">
                <div className="progress-bar-container">
                    <div
                        className="progress-bar-fill"
                        style={{ width: `${progressPercentage}%` }}
                        aria-valuenow={progressPercentage}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        role="progressbar"
                    ></div>
                </div>
                <span className="progress-label">
                    進捗: {completedTasksCount} / {totalTasksCount} ({progressPercentage}%)
                </span>
            </div>
        )}
        
        {error && <p className="error-message">{error}</p>}

        {aiSuggestion && (
            <div className="ai-suggestion">
                <button className="close-btn" onClick={() => setAiSuggestion(null)} aria-label="閉じる">&times;</button>
                <h3>AIからのおすすめ</h3>
                <p className="suggestion-task">{aiSuggestion.taskText}</p>
                <p className="suggestion-reason">{aiSuggestion.reason}</p>
            </div>
        )}

        <div className="tabs">
          <button
            className={`tab-btn ${activeMatrix === "A" ? "active" : ""}`}
            onClick={() => setActiveMatrix("A")}
            aria-pressed={activeMatrix === "A"}
            disabled={isTimerRunning}
          >
            重要 × 緊急
          </button>
          <button
            className={`tab-btn ${activeMatrix === "B" ? "active" : ""}`}
            onClick={() => setActiveMatrix("B")}
            aria-pressed={activeMatrix === "B"}
            disabled={isTimerRunning}
          >
            やりたい × 求められる
          </button>
          <button
            className={`tab-btn ${activeMatrix === "C" ? "active" : ""}`}
            onClick={() => setActiveMatrix("C")}
            aria-pressed={activeMatrix === "C"}
            disabled={isTimerRunning}
          >
            やりたい × できる
          </button>
        </div>

        {renderMatrix(activeMatrix)}
      </main>
      <DecompositionModal
          isOpen={isDecompositionModalOpen}
          onClose={handleCloseDecompositionModal}
          onAdd={handleAddSelectedSubTasks}
          task={taskToDecompose}
          subTasks={decomposedSubTasks}
          isLoading={isDecomposing}
      />
    </>
  );
};

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
