import React, { useEffect, useState } from 'react';
import { GameState, Room, isValidMove, selectAICard, calculateAICall } from '@callbreak/shared';
import { io, Socket } from 'socket.io-client';
import { AuthPage } from './pages/AuthPage.js';
import { Navbar } from './components/layout/Navbar.js';
import { GamePage } from './pages/GamePage.js';
import { HomePage } from './pages/HomePage.js';
import { LeaderboardPage } from './pages/LeaderboardPage.js';
import { LobbyPage } from './pages/LobbyPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { VoiceControls } from './components/voice/VoiceControls.js';
import { useVoiceChat } from './hooks/useVoiceChat.js';
import { clientGameManager } from './services/clientGameManager.js';
import { soundFx } from './audio/soundSystem.js';
import { useAuthStore } from './stores/authStore.js';
import { useGameStore } from './stores/gameStore.js';
import { apiUrl, getSocketUrl } from './config/apiConfig.js';

type ViewMode = 'auth' | 'home' | 'game' | 'profile' | 'leaderboard' | 'lobby';

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewMode>('auth');
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [turnSecondsLeft, setTurnSecondsLeft] = useState(20);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const { user, setUser, logout } = useAuthStore();
  const { gameState, setGameState, setSelectedCardId } = useGameStore();

  const humanUserId = user?.id || '';
  const humanUserName = user?.username || '';
  const currentTurnName = gameState?.players[gameState.currentTurnSeat]?.name || '';

  const {
    isJoined: isVoiceJoined,
    isMuted: isVoiceMuted,
    isDeafened: isVoiceDeafened,
    speakingUserIds,
    mutedPeerIds,
    mutedPlayerIds,
    errorMsg: voiceErrorMsg,
    toggleVoice,
    toggleMute: toggleVoiceMute,
    toggleDeafen: toggleVoiceDeafen,
    togglePeerMute,
  } = useVoiceChat(socket, activeRoom?.code || null, humanUserId, humanUserName);

  useEffect(() => {
    const hydrateSession = async () => {
      try {
        const res = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' });
        if (!res.ok) {
          if (!user) {
            setUser(null, null);
            setCurrentView('auth');
          }
          return;
        }

        const data = await res.json();
        if (data.user) {
          setUser(data.user, null);
          setCurrentView('home');
        } else if (!user) {
          setUser(null, null);
          setCurrentView('auth');
        }
      } catch {
        if (!user) {
          setUser(null, null);
          setCurrentView('auth');
        }
      } finally {
        setAuthLoading(false);
      }
    };

    hydrateSession();
  }, [setUser]);

  // Setup Socket with user details
  useEffect(() => {
    if (!user) {
      setSocket(null);
      return;
    }

    const serverUrl = getSocketUrl();
    const nextSocket = io(serverUrl, {
      withCredentials: true,
      autoConnect: true,
      auth: {
        userId: user.id,
        username: user.username,
      },
    });

    nextSocket.on('room:updated', (room: Room) => {
      setActiveRoom(room);
    });

    nextSocket.on('game:state', (state: GameState) => {
      setGameState(state);
      setCurrentView('game');
    });

    nextSocket.on('game:error', (message: string) => {
      alert(message);
    });

    setSocket(nextSocket);

    return () => {
      nextSocket.disconnect();
      setSocket(null);
    };
  }, [user, setGameState]);

  const [recordedGameId, setRecordedGameId] = useState<string | null>(null);

  // Turn management and AI progression loop for single-player vs AI
  useEffect(() => {
    if (!gameState) return;

    // In multiplayer mode, the server controls AI progression and authoritative state
    if (activeRoom) {
      setTurnSecondsLeft(20);
      const countdownTimer = window.setInterval(() => {
        setTurnSecondsLeft((secondsLeft) => Math.max(secondsLeft - 1, 0));
      }, 1000);
      return () => window.clearInterval(countdownTimer);
    }

    if (gameState.phase === 'game_over') {
      setTurnSecondsLeft(20);

      // Persist single player game to database once
      if (gameState.id !== recordedGameId) {
        setRecordedGameId(gameState.id);
        const sortedPlayers = [...gameState.players].sort((a, b) => b.totalScore - a.totalScore);
        const payload = {
          winnerId: gameState.winnerId,
          players: sortedPlayers.map((p, idx) => ({
            id: p.id,
            name: p.name,
            totalScore: p.totalScore,
            rank: idx + 1,
            isAI: p.isAI,
          })),
        };

        fetch(apiUrl('/api/users/record-game'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        }).catch((err) => console.error('Failed to record match:', err));
      }

      return;
    }

    // Handle Trick completion pause in single player
    if (
      gameState.phase === 'playing' &&
      gameState.currentTrick.cards.length === 4 &&
      gameState.currentTrick.winnerId
    ) {
      setTurnSecondsLeft(20);
      soundFx.playTrickWin();

      const gameId = gameState.id;
      const trickTimer = window.setTimeout(() => {
        const current = useGameStore.getState().gameState;
        if (!current || current.id !== gameId) return;

        const updated = clientGameManager.resolveCompletedTrick(current);
        if (updated) {
          setGameState({ ...updated });
        }
      }, 1800);

      return () => window.clearTimeout(trickTimer);
    }

    if (gameState.phase === 'round_end') {
      setTurnSecondsLeft(20);
      return;
    }

    const currentPlayer = gameState.players[gameState.currentTurnSeat];
    if (!currentPlayer) return;

    setTurnSecondsLeft(20);

    const countdownTimer = window.setInterval(() => {
      setTurnSecondsLeft((secondsLeft) => Math.max(secondsLeft - 1, 0));
    }, 1000);

    // Schedule one turn action — bots at 1.1s, humans at 20s (timeout fallback)
    let cancelled = false;
    const gameId = gameState.id;
    const turnSeat = gameState.currentTurnSeat;
    const turnPhase = gameState.phase;
    const turnPlayerId = currentPlayer.id;
    const isBotTurn = currentPlayer.isAI;
    const turnDuration = isBotTurn ? 1100 : 20000;

    const turnTimer = window.setTimeout(() => {
      if (cancelled) return;

      const current = useGameStore.getState().gameState;
      if (!current || current.id !== gameId) return;
      if (current.currentTurnSeat !== turnSeat || current.phase !== turnPhase) return;
      if (current.currentTrick.cards.length >= 4) return;

      const turnPlayer = current.players[turnSeat];
      if (!turnPlayer || turnPlayer.id !== turnPlayerId) return;

      if (isBotTurn) {
        // Bot turn — only bots may act here; blocks stale timers hitting the human
        if (!turnPlayer.isAI) return;

        const updated = clientGameManager.processNextAITurn(current);
        if (updated) {
          if (current.phase === 'playing') {
            soundFx.playCardPlay();
          }
          setGameState({ ...updated });
        }
        return;
      }

      // Human turn timeout — only after full 20s on the same player's turn
      if (turnPlayer.isAI) return;

      if (current.phase === 'bidding') {
        const bestCall = calculateAICall(turnPlayer.cards, turnPlayer.aiDifficulty || 'medium');
        const updated = clientGameManager.submitCall(current, turnPlayer.id, bestCall);
        setGameState({ ...updated });
        return;
      }

      if (current.phase === 'playing') {
        const bestCard = selectAICard(
          turnPlayer.cards,
          current.currentTrick.leadSuit,
          current.currentTrick.cards,
          turnPlayer.call || 1,
          turnPlayer.tricksWon,
          turnPlayer.aiDifficulty || 'medium',
          turnPlayer.id
        );
        soundFx.playCardPlay();
        const updated = clientGameManager.playCard(current, turnPlayer.id, bestCard.id);
        setGameState({ ...updated });
      }
    }, turnDuration);

    return () => {
      cancelled = true;
      window.clearInterval(countdownTimer);
      window.clearTimeout(turnTimer);
    };
  }, [gameState, setGameState, activeRoom]);

  // Single-player VS AI Initialization
  const handleStartVsAI = (difficulty: 'easy' | 'medium' | 'hard', rounds: number = 1) => {
    if (!user) return;

    setActiveRoom(null);
    const newGame = clientGameManager.createSinglePlayerGame(
      { id: humanUserId, name: humanUserName, avatar: user.avatar || 'avatar-1' },
      difficulty,
      rounds
    );
    setGameState(newGame);
    setCurrentView('game');
  };

  // Submit Bidding Call (Supports both Local Single Player and Real-time Multiplayer)
  const handleSubmitCall = (callValue: number) => {
    if (!gameState) return;
    if (activeRoom && socket) {
      socket.emit('game:call', { roomCode: activeRoom.code, playerId: humanUserId, callValue });
    } else {
      const updated = clientGameManager.submitCall(gameState, humanUserId, callValue);
      setGameState({ ...updated });
    }
  };

  // Play Card (Supports both Local Single Player and Real-time Multiplayer)
  const handlePlayCard = (cardId: string) => {
    if (!gameState) return;

    const currentPlayer = gameState.players[gameState.currentTurnSeat];
    const humanPlayer = gameState.players.find((p) => p.id === humanUserId);
    if (!currentPlayer || !humanPlayer) return;
    if (currentPlayer.id !== humanUserId) return;
    if (gameState.phase !== 'playing') return;
    if (gameState.currentTrick.cards.length >= 4) return;
    if (!humanPlayer.cards.some((c) => c.id === cardId)) return;
    if (
      !isValidMove(
        cardId,
        humanPlayer.cards,
        gameState.currentTrick.leadSuit,
        gameState.currentTrick.cards
      )
    ) {
      return;
    }

    soundFx.playCardPlay();
    if (activeRoom && socket) {
      socket.emit('game:play_card', { roomCode: activeRoom.code, playerId: humanUserId, cardId });
    } else {
      const updated = clientGameManager.playCard(gameState, humanUserId, cardId);
      if (updated === gameState) return;
      setGameState({ ...updated });
    }
  };

  // Next Round
  const handleNextRound = () => {
    if (!gameState) return;
    if (activeRoom && socket) {
      socket.emit('game:next_round', { roomCode: activeRoom.code });
    } else {
      const nextGame = clientGameManager.startNextRound(gameState);
      setGameState({ ...nextGame });
    }
  };

  // Play Again — full rematch reset (same players, fresh deal & scores)
  const handlePlayAgain = () => {
    if (!gameState || !user) return;

    setRecordedGameId(null);
    setSelectedCardId(null);

    if (activeRoom && socket) {
      socket.emit(
        'room:start',
        { roomCode: activeRoom.code, rounds: gameState.maxRounds || 1 },
        (response: { success: boolean; game?: GameState; error?: string }) => {
          if (response?.game) {
            setGameState(response.game);
            setCurrentView('game');
          } else if (response?.error) {
            alert(response.error);
          }
        }
      );
      return;
    }

    setActiveRoom(null);
    const newGame = clientGameManager.restartMatch(gameState);
    setGameState({ ...newGame });
    setCurrentView('game');
  };

  // Create Room
  const handleCreateRoom = () => {
    if (!user || !socket) return;

    socket.emit(
      'room:create',
      { player: { id: humanUserId, name: humanUserName, avatar: user.avatar || 'avatar-1' } },
      (response: { success: boolean; room?: Room; error?: string }) => {
        if (!response.success || !response.room) {
          alert(response.error || 'Could not create room');
          return;
        }

        setActiveRoom(response.room);
        setCurrentView('lobby');
      }
    );
  };

  // Join Room
  const handleJoinRoom = (code: string) => {
    if (!user || !socket) return;

    socket.emit(
      'room:join',
      { roomCode: code, player: { id: humanUserId, name: humanUserName, avatar: user.avatar || 'avatar-1' } },
      (response: { success: boolean; room?: Room; error?: string }) => {
        if (!response.success || !response.room) {
          alert(response.error || 'Could not join room');
          return;
        }

        setActiveRoom(response.room);
        setCurrentView('lobby');
      }
    );
  };

  // Toggle Ready in Lobby
  const handleLobbyReady = () => {
    if (!activeRoom || !socket) return;
    socket.emit(
      'room:toggle_ready',
      { roomCode: activeRoom.code, playerId: humanUserId },
      (response: { success: boolean; room?: Room }) => {
        if (response?.room) {
          setActiveRoom(response.room);
        }
      }
    );
  };

  // Host Launch Room Game
  const handleStartLobbyGame = (rounds: number = 1) => {
    if (!activeRoom || !socket) return;
    socket.emit('room:start', { roomCode: activeRoom.code, rounds }, (response: { success: boolean; game?: GameState; error?: string }) => {
      if (response?.game) {
        setGameState(response.game);
        setCurrentView('game');
      } else if (response?.error) {
        alert(response.error);
      }
    });
  };

  const handleAuthenticated = () => {
    setCurrentView('home');
  };

  const handleLogout = () => {
    logout();
    setActiveRoom(null);
    setGameState(null);
    setCurrentView('auth');
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0B0E13] text-[#F1F5F9] flex items-center justify-center font-mono">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full border border-[#00D5FF]/40 flex items-center justify-center text-[#00D5FF] animate-pulse">
            ♠
          </div>
          <div className="text-xs tracking-[0.25em] text-[#00D5FF] uppercase">Loading session</div>
        </div>
      </div>
    );
  }

  if (currentView === 'auth' || !user) {
    return <AuthPage onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="min-h-screen bg-[#0B0E13] text-[#F1F5F9] font-sans flex flex-col justify-between">
      <Navbar
        onNavigateHome={() => setCurrentView('home')}
        onNavigateProfile={() => setCurrentView('profile')}
        onNavigateLeaderboard={() => setCurrentView('leaderboard')}
        onLogout={handleLogout}
      />

      <main className="flex-1">
        {currentView === 'home' && (
          <HomePage
            onStartVsAI={handleStartVsAI}
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
          />
        )}

        {currentView === 'game' && gameState && (
          <GamePage
            gameState={gameState}
            humanPlayerId={humanUserId}
            currentTurnName={currentTurnName}
            turnSecondsLeft={turnSecondsLeft}
            onSubmitCall={handleSubmitCall}
            onPlayCard={handlePlayCard}
            onNextRound={handleNextRound}
            onPlayAgain={handlePlayAgain}
            onReturnHome={() => setCurrentView('home')}
            voiceControlsNode={
              <VoiceControls
                isJoined={isVoiceJoined}
                isMuted={isVoiceMuted}
                isDeafened={isVoiceDeafened}
                isMultiplayer={!!activeRoom}
                errorMsg={voiceErrorMsg}
                onToggleVoice={toggleVoice}
                onToggleMute={toggleVoiceMute}
                onToggleDeafen={toggleVoiceDeafen}
              />
            }
            speakingUserIds={speakingUserIds}
            mutedPeerIds={mutedPeerIds}
            mutedPlayerIds={mutedPlayerIds}
            isVoiceMuted={isVoiceMuted}
            onTogglePeerMute={togglePeerMute}
          />
        )}

        {currentView === 'profile' && <ProfilePage />}

        {currentView === 'leaderboard' && <LeaderboardPage />}

        {currentView === 'lobby' && activeRoom && (
          <LobbyPage
            room={activeRoom}
            currentUserId={humanUserId}
            onReady={handleLobbyReady}
            onStartGame={handleStartLobbyGame}
          />
        )}
      </main>
    </div>
  );
};
