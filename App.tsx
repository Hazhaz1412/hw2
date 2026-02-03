import { Audio } from 'expo-av';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const ASSEMBLYAI_API_KEY = Constants.expoConfig?.extra?.assemblyaiApiKey ?? '';
const GENIUS_ACCESS_TOKEN = Constants.expoConfig?.extra?.geniusAccessToken ?? '';
const AUDD_API_TOKEN = Constants.expoConfig?.extra?.auddApiToken ?? '';

const LANGUAGE_OPTIONS = [
  { label: 'Vietnamese', value: 'vi' },
  { label: 'English', value: 'en' },
  { label: 'Spanish', value: 'es' },
  { label: 'Japanese', value: 'ja' },
  { label: 'Korean', value: 'ko' },
];

type SongResult = {
  id: number;
  title: string;
  artist: string;
  fullTitle: string;
  songUrl: string;
  imageUrl?: string;
  source: 'audd' | 'genius';
};

type HistoryItem = {
  id: string;
  transcript: string;
  cleaned: string;
  result?: SongResult;
  createdAt: string;
};

const RECORDING_PRESET = Audio.RecordingOptionsPresets.HIGH_QUALITY;
const CHUNK_MS = 8000;
const VU_MIN_DB = -60;
const VU_MAX_DB = -10;

export default function App() {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [cleanedText, setCleanedText] = useState('');
  const [songResult, setSongResult] = useState<SongResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [language, setLanguage] = useState(LANGUAGE_OPTIONS[0].value);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [vuLevel, setVuLevel] = useState(0);
  const [candidates, setCandidates] = useState<
    Array<{ id: string; title: string; artist: string; score: number; source: string }>
  >([]);

  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeSessionRef = useRef(0);
  const isStoppingRef = useRef(false);

  const hasKeys = useMemo(() => {
    return ASSEMBLYAI_API_KEY.trim().length > 10 &&
      GENIUS_ACCESS_TOKEN.trim().length > 10 &&
      AUDD_API_TOKEN.trim().length > 10;
  }, []);

  useEffect(() => {
    return () => {
      if (recording) {
        recording.stopAndUnloadAsync().catch(() => {});
      }
      clearChunkTimer();
    };
  }, [recording]);

  const normalizeLyrics = (text: string) => {
    const noPunctuation = text
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return noPunctuation;
  };

  const buildSearchQueries = (cleaned: string) => {
    const words = cleaned.split(' ').filter((word) => word.length > 2);
    const uniqueWords = Array.from(new Set(words));
    const topKeywords = [...uniqueWords].sort((a, b) => b.length - a.length).slice(0, 6);
    const firstPhrase = words.slice(0, 8).join(' ');
    const middlePhrase = words.slice(Math.max(0, Math.floor(words.length / 3)), Math.max(8, Math.floor(words.length / 3) + 8)).join(' ');

    const queries = [
      cleaned,
      firstPhrase,
      middlePhrase,
      topKeywords.join(' '),
    ]
      .map((item) => item.trim())
      .filter((item) => item.length >= 6);

    return Array.from(new Set(queries));
  };

  const startRecording = async () => {
    setErrorMessage('');
    setStatusMessage('');
    setSongResult(null);
    setTranscriptText('');
    setCleanedText('');
    setCandidates([]);

    if (!hasKeys) {
      Alert.alert('Missing API keys', 'Please add AssemblyAI, Genius, and AudD keys in App.tsx.');
      return;
    }

    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage('Microphone permission is required.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      activeSessionRef.current += 1;
      isStoppingRef.current = false;
      await startChunk(activeSessionRef.current);
      setIsRecording(true);
    } catch (error) {
      setErrorMessage('Cannot start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    if (!recording || isStoppingRef.current) {
      return;
    }

    isStoppingRef.current = true;
    setIsRecording(false);
    clearChunkTimer();

    try {
      const stoppedRecording = recording;
      setRecording(null);
      await stoppedRecording.stopAndUnloadAsync();
      const uri = stoppedRecording.getURI();

      if (!uri) {
        setErrorMessage('No audio recorded.');
        return;
      }

      await transcribeAndSearch(uri);
    } catch (error) {
      setErrorMessage('Cannot stop recording. Please try again.');
    } finally {
      isStoppingRef.current = false;
    }
  };

  const clearChunkTimer = () => {
    if (chunkTimerRef.current) {
      clearInterval(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
  };

  const startChunk = async (sessionId: number) => {
    const newRecording = new Audio.Recording();
    await newRecording.prepareToRecordAsync({
      ...RECORDING_PRESET,
      isMeteringEnabled: true,
    });

    newRecording.setOnRecordingStatusUpdate((status) => {
      if (!status.isRecording || typeof status.metering !== 'number') {
        return;
      }
      const normalized = Math.min(
        1,
        Math.max(0, (status.metering - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB))
      );
      setVuLevel(normalized);
    });

    await newRecording.startAsync();
    setRecording(newRecording);

    clearChunkTimer();
    chunkTimerRef.current = setInterval(async () => {
      if (isStoppingRef.current || !newRecording) {
        return;
      }
      try {
        await newRecording.stopAndUnloadAsync();
        const uri = newRecording.getURI();
        if (uri && sessionId === activeSessionRef.current) {
          await transcribeAndSearch(uri, true);
        }
      } catch {
        return;
      }

      if (sessionId !== activeSessionRef.current || isStoppingRef.current) {
        return;
      }

      await startChunk(sessionId);
    }, CHUNK_MS);
  };

  const transcribeAndSearch = async (uri: string, isChunk = false) => {
    if (!isChunk) {
      setIsTranscribing(true);
    }
    setErrorMessage('');
    setStatusMessage('Đang nhận diện nhạc bằng AudD...');

    try {
      const audioResult = await identifySongByAudio(uri);
      if (audioResult) {
        setSongResult(audioResult);
        updateCandidates(audioResult, 0.92);
      }

      setStatusMessage('Đang chuyển giọng nói thành văn bản...');
      const uploadUrl = await uploadAudioToAssemblyAI(uri);
      const transcript = await requestTranscript(uploadUrl, language);

      if (!transcript || transcript.trim().length === 0) {
        setErrorMessage('No speech detected. Please speak clearly and try again.');
        setIsTranscribing(false);
        return;
      }

      setTranscriptText(transcript);
      const normalized = normalizeLyrics(transcript);
      setCleanedText(normalized);

      if (normalized.split(' ').length < 4) {
        setErrorMessage('Nhận diện quá ngắn. Hãy nói rõ lời bài hát và giảm tiếng nhạc nền.');
        setIsTranscribing(false);
        return;
      }

      let finalResult = audioResult;
      if (!finalResult) {
        setStatusMessage('Đang tìm bài hát theo lời thoại...');
        finalResult = await searchSong(normalized);
        setSongResult(finalResult);
        if (finalResult) {
          updateCandidates(finalResult, estimateLyricsScore(normalized));
        }
      }

      if (!isChunk) {
        setHistory((prev) => [
          {
            id: String(Date.now()),
            transcript,
            cleaned: normalized,
            result: finalResult ?? undefined,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
    } catch (error) {
      setErrorMessage('Processing failed. Please try again.');
    } finally {
      if (!isChunk) {
        setIsTranscribing(false);
      }
      setStatusMessage('');
    }
  };

  const uploadAudioToAssemblyAI = async (uri: string) => {
    const audioResponse = await fetch(uri);
    const audioBlob = await audioResponse.blob();

    const response = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
      },
      body: audioBlob,
    });

    if (!response.ok) {
      throw new Error('Upload failed');
    }

    const data = await response.json();
    return data.upload_url as string;
  };

  const requestTranscript = async (audioUrl: string, lang: string) => {
    const response = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        language_code: lang,
      }),
    });

    if (!response.ok) {
      throw new Error('Transcript request failed');
    }

    const data = await response.json();
    const id = data.id as string;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { authorization: ASSEMBLYAI_API_KEY },
      });
      const statusData = await statusResponse.json();

      if (statusData.status === 'completed') {
        return statusData.text as string;
      }

      if (statusData.status === 'error') {
        throw new Error(statusData.error || 'Transcription failed');
      }
    }

    throw new Error('Transcription timeout');
  };

  const identifySongByAudio = async (uri: string): Promise<SongResult | null> => {
    if (AUDD_API_TOKEN.trim().length < 10) {
      return null;
    }

    const formData = new FormData();
    formData.append('api_token', AUDD_API_TOKEN);
    formData.append('return', 'spotify,apple_music');
    formData.append('file', {
      uri,
      name: 'recording.m4a',
      type: 'audio/m4a',
    } as unknown as Blob);

    const response = await fetch('https://api.audd.io/', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.status !== 'success' || !data.result) {
      return null;
    }

    return {
      id: Number(data.result?.song_id ?? Date.now()),
      title: data.result?.title ?? 'Unknown title',
      artist: data.result?.artist ?? 'Unknown artist',
      fullTitle: `${data.result?.artist ?? 'Unknown'} - ${data.result?.title ?? 'Unknown'}`,
      songUrl: data.result?.song_link ?? '',
      imageUrl: data.result?.spotify?.album?.images?.[0]?.url,
      source: 'audd',
    };
  };

  const estimateLyricsScore = (text: string) => {
    const wordCount = text.split(' ').filter(Boolean).length;
    const score = 0.4 + Math.min(0.45, wordCount * 0.02);
    return Math.min(0.85, Math.max(0.4, score));
  };

  const updateCandidates = (result: SongResult, score: number) => {
    setCandidates((prev) => {
      const key = `${result.title}-${result.artist}`;
      const existing = prev.find((item) => item.id === key);
      const nextScore = existing ? Math.max(existing.score, score) : score;
      const next = [
        { id: key, title: result.title, artist: result.artist, score: nextScore, source: result.source },
        ...prev.filter((item) => item.id !== key),
      ]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (next[0] && next[0].score >= 0.9) {
        setStatusMessage(`Đã có kết quả tự tin: ${next[0].title}`);
      }

      return next;
    });
  };

  const searchSong = async (query: string): Promise<SongResult | null> => {
    if (!query || query.length < 3) {
      setErrorMessage('Not enough text to search.');
      return null;
    }

    const queries = buildSearchQueries(query);
    for (const candidate of queries) {
      const response = await fetch(
        `https://api.genius.com/search?q=${encodeURIComponent(candidate)}`,
        {
          headers: {
            Authorization: `Bearer ${GENIUS_ACCESS_TOKEN}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data = await response.json();
      const hits = data.response?.hits ?? [];
      if (hits.length > 0) {
        const song = hits[0].result;
        return {
          id: song.id,
          title: song.title,
          artist: song.primary_artist?.name ?? 'Unknown artist',
          fullTitle: song.full_title,
          songUrl: song.url,
          imageUrl: song.song_art_image_url,
          source: 'genius',
        };
      }
    }

    return null;
  };

  const clearResult = () => {
    setTranscriptText('');
    setCleanedText('');
    setSongResult(null);
    setErrorMessage('');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Ứng dụng nhận diện tên bài nhạc</Text>
        <Text style={styles.subtitle}>Từ lời thoại với AssemblyAI + Genius</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ngôn ngữ nhận diện</Text>
          <View style={styles.languageRow}>
            {LANGUAGE_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => setLanguage(option.value)}
                style={[
                  styles.languageChip,
                  language === option.value && styles.languageChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.languageText,
                    language === option.value && styles.languageTextActive,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ghi âm</Text>
          <View style={styles.controls}>
            <Pressable
              onPress={startRecording}
              disabled={isRecording || isTranscribing}
              style={[styles.button, (isRecording || isTranscribing) && styles.buttonDisabled]}
            >
              <Text style={styles.buttonText}>Record</Text>
            </Pressable>
            <Pressable
              onPress={stopRecording}
              disabled={!isRecording}
              style={[styles.button, !isRecording && styles.buttonDisabled]}
            >
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
            <Pressable onPress={clearResult} style={styles.buttonSecondary}>
              <Text style={styles.buttonSecondaryText}>Clear</Text>
            </Pressable>
          </View>

          {isTranscribing && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#FFB703" />
              <Text style={styles.loadingText}>{statusMessage || 'Đang xử lý...'}</Text>
            </View>
          )}

          {!isTranscribing && statusMessage.length > 0 && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#38BDF8" />
              <Text style={styles.loadingText}>{statusMessage}</Text>
            </View>
          )}

          {isRecording && (
            <View style={styles.vuWrapper}>
              <Text style={styles.vuLabel}>Đang lắng nghe</Text>
              <View style={styles.vuTrack}>
                <View style={[styles.vuFill, { width: `${Math.round(vuLevel * 100)}%` }]} />
              </View>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Văn bản nhận diện</Text>
          <View style={styles.card}>
            <Text style={styles.cardText}>
              {transcriptText || 'Chưa có dữ liệu.'}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Văn bản đã làm sạch</Text>
          <View style={styles.card}>
            <Text style={styles.cardText}>
              {cleanedText || 'Chưa có dữ liệu.'}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Kết quả</Text>
          <View style={styles.card}>
            {songResult ? (
              <>
                <Text style={styles.resultTitle}>{songResult.title}</Text>
                <Text style={styles.resultArtist}>{songResult.artist}</Text>
                <Text style={styles.resultSource}>
                  Nguồn nhận diện: {songResult.source === 'audd' ? 'AudD (nhạc)' : 'Genius (lyrics)'}
                </Text>
                <Text style={styles.resultSnippet}>
                  Khớp theo lời thoại: "{cleanedText.slice(0, 120)}"
                </Text>
                <Text style={styles.resultLink}>
                  Link: {songResult.songUrl || 'Không có'}
                </Text>
              </>
            ) : (
              <Text style={styles.cardText}>Không tìm thấy bài hát phù hợp.</Text>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Gợi ý (live)</Text>
          {candidates.length === 0 ? (
            <Text style={styles.mutedText}>Chưa có gợi ý.</Text>
          ) : (
            candidates.map((item) => (
              <View key={item.id} style={styles.candidateItem}>
                <Text style={styles.candidateTitle}>{item.title}</Text>
                <Text style={styles.candidateArtist}>{item.artist}</Text>
                <Text style={styles.candidateScore}>Độ tin cậy: {Math.round(item.score * 100)}%</Text>
                <Text style={styles.candidateSource}>
                  Nguồn: {item.source === 'audd' ? 'AudD' : 'Genius'}
                </Text>
              </View>
            ))
          )}
        </View>

        {errorMessage.length > 0 && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lịch sử tìm kiếm</Text>
          {history.length === 0 ? (
            <Text style={styles.mutedText}>Chưa có lịch sử.</Text>
          ) : (
            history.map((item) => (
              <View key={item.id} style={styles.historyItem}>
                <Text style={styles.historyDate}>{item.createdAt}</Text>
                <Text style={styles.historyText}>Nhận diện: {item.transcript}</Text>
                <Text style={styles.historyText}>Làm sạch: {item.cleaned}</Text>
                <Text style={styles.historyText}>
                  Kết quả: {item.result ? item.result.fullTitle : 'Không tìm thấy'}
                </Text>
                {item.result && (
                  <Text style={styles.historyText}>
                    Nguồn: {item.result.source === 'audd' ? 'AudD' : 'Genius'}
                  </Text>
                )}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  container: {
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    color: '#F8FAFC',
    fontWeight: '700',
  },
  subtitle: {
    color: '#94A3B8',
    marginTop: 6,
    marginBottom: 16,
  },
  section: {
    marginTop: 18,
  },
  sectionTitle: {
    color: '#E2E8F0',
    fontWeight: '600',
    marginBottom: 8,
  },
  languageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  languageChip: {
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  languageChipActive: {
    backgroundColor: '#F97316',
    borderColor: '#F97316',
  },
  languageText: {
    color: '#CBD5F5',
  },
  languageTextActive: {
    color: '#0F172A',
    fontWeight: '600',
  },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  button: {
    backgroundColor: '#22C55E',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#0F172A',
    fontWeight: '700',
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: '#64748B',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  buttonSecondaryText: {
    color: '#E2E8F0',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  loadingText: {
    color: '#F8FAFC',
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
  },
  cardText: {
    color: '#E2E8F0',
    lineHeight: 20,
  },
  resultTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
  resultArtist: {
    color: '#FDBA74',
    marginTop: 4,
    marginBottom: 8,
  },
  resultSource: {
    color: '#A5B4FC',
    marginBottom: 8,
  },
  resultSnippet: {
    color: '#CBD5F5',
    marginBottom: 8,
  },
  resultLink: {
    color: '#38BDF8',
  },
  errorBox: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#7F1D1D',
    borderRadius: 10,
  },
  errorText: {
    color: '#FEF2F2',
  },
  mutedText: {
    color: '#94A3B8',
  },
  historyItem: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#111827',
    borderRadius: 10,
  },
  historyDate: {
    color: '#64748B',
    fontSize: 12,
    marginBottom: 6,
  },
  historyText: {
    color: '#E2E8F0',
    marginBottom: 4,
  },
  vuWrapper: {
    marginTop: 12,
    padding: 10,
    backgroundColor: '#0B1120',
    borderRadius: 10,
  },
  vuLabel: {
    color: '#F8FAFC',
    marginBottom: 8,
  },
  vuTrack: {
    height: 8,
    backgroundColor: '#1F2937',
    borderRadius: 999,
    overflow: 'hidden',
  },
  vuFill: {
    height: '100%',
    backgroundColor: '#22D3EE',
  },
  candidateItem: {
    marginTop: 10,
    padding: 12,
    backgroundColor: '#0B1120',
    borderRadius: 10,
  },
  candidateTitle: {
    color: '#F8FAFC',
    fontWeight: '700',
  },
  candidateArtist: {
    color: '#A5B4FC',
    marginTop: 2,
  },
  candidateScore: {
    color: '#FBBF24',
    marginTop: 6,
  },
  candidateSource: {
    color: '#94A3B8',
    marginTop: 2,
  },
});
