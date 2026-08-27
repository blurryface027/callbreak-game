import {
  calculateAICall,
  calculateRoundScores,
  createDeck,
  dealCards,
  determineTrickWinner,
  GameState,
  isValidMove,
  Player,
  Room,
  RoomPlayer,
  selectAICard,
  shuffleDeck,
} from '@callbreak/shared';

export class RoomManager {
  private rooms: Map<string, Room> = new Map(); // roomId or code -> Room
  private games: Map<string, GameState> = new Map(); // gameId or roomCode -> GameState
  private turnTimers: Map<string, NodeJS.Timeout> = new Map(); // roomCode -> turn timeout timer
  private stateChangeCallback?: (roomCode: string, state: GameState) => void;

  public onStateChange(callback: (roomCode: string, state: GameState) => void) {
    this.stateChangeCallback = callback;
  }

  private notifyStateChange(roomCodeOrId: string, state: GameState) {
    if (this.stateChangeCallback) {
      const code = roomCodeOrId.replace('game-room-', '');
      this.stateChangeCallback(code, state);
    }
  }

  createRoom(hostPlayer: { id: string; name: string; avatar: string }): Room {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room: Room = {
      id: `room-${Date.now()}`,
      code,
      hostId: hostPlayer.id,
      players: [
        {
          id: hostPlayer.id,
          name: hostPlayer.name,
          avatar: hostPlayer.avatar,
          isHost: true,
          isReady: true,
          isAI: false,
        },
      ],
      maxPlayers: 4,
      status: 'waiting',
      createdAt: Date.now(),
    };
    this.rooms.set(room.id, room);
    this.rooms.set(room.code, room);
    return room;
  }

  getRoomByCode(code: string): Room | undefined {
    const upper = code.toUpperCase();
    if (this.rooms.has(upper)) return this.rooms.get(upper);
    for (const room of this.rooms.values()) {
      if (room.code.toUpperCase() === upper) return room;
    }
    return undefined;
  }

  joinRoom(
    roomCode: string,
    player: { id: string; name: string; avatar: string }
  ): Room {
    const room = this.getRoomByCode(roomCode);
    if (!room) throw new Error('Room not found. Check the 6-character room code.');
    if (room.status !== 'waiting') throw new Error('Game already in progress');

    const existingIndex = room.players.findIndex((p) => p.id === player.id);
    if (existingIndex !== -1) {
      room.players[existingIndex].name = player.name;
      room.players[existingIndex].avatar = player.avatar;
      return room;
    }

    if (room.players.length >= 4) throw new Error('Room is full (max 4 players)');

    room.players.push({
      id: player.id,
      name: player.name,
      avatar: player.avatar || 'avatar-1',
      isHost: false,
      isReady: true,
      isAI: false,
    });

    return room;
  }

  toggleReady(roomCode: string, playerId: string): Room | undefined {
    const room = this.getRoomByCode(roomCode);
    if (!room) return undefined;
    const player = room.players.find((p) => p.id === playerId);
    if (player) {
      player.isReady = !player.isReady;
    }
    return room;
  }

  startRoomGame(roomCode: string, rounds: number = 1): GameState {
    const room = this.getRoomByCode(roomCode);
    if (!room) throw new Error('Room not found');
    if (room.status === 'playing') throw new Error('Game already in progress');

    const botNames = ['CYAN BOT', 'APEX BOT', 'NEXUS BOT'];
    const filledPlayers: RoomPlayer[] = [...room.players];
    while (filledPlayers.length < 4) {
      const idx = filledPlayers.length;
      filledPlayers.push({
        id: `bot-${idx}-${Date.now()}`,
        name: botNames[idx - 1] || `BOT_${idx}`,
        avatar: `bot-${idx}`,
        isHost: false,
        isReady: true,
        isAI: true,
        aiDifficulty: 'medium',
      });
    }

    room.players = filledPlayers;
    room.status = 'playing';

    const game = this.initGameState(`game-room-${room.code}`, filledPlayers, rounds);
    this.games.set(room.code, game);
    this.games.set(game.id, game);

    this.startTurnTimer(room.code);
    return game;
  }

  startNextRoomRound(roomCode: string): GameState {
    const game = this.getGame(roomCode);
    if (!game) throw new Error('Game not found');
    if (game.phase !== 'round_end') {
      throw new Error('The current round has not finished yet');
    }
    if (game.currentRound >= game.maxRounds) {
      game.phase = 'game_over';
      this.notifyStateChange(game.id, game);
      return game;
    }

    game.currentRound += 1;
    game.dealerSeat = (game.dealerSeat + 1) % game.players.length;
    game.currentTurnSeat = (game.dealerSeat + 1) % game.players.length;
    game.phase = 'bidding';
    game.trickHistory = [];
    game.currentTrick = {
      trickNumber: 1,
      leadSuit: null,
      cards: [],
      winnerId: null,
    };

    const hands = dealCards(shuffleDeck(createDeck()));
    game.players.forEach((player, index) => {
      player.cards = hands[index];
      player.call = null;
      player.tricksWon = 0;
    });

    this.notifyStateChange(game.id, game);
    return game;
  }

  createSinglePlayerGame(
    humanPlayer: { id: string; name: string; avatar: string },
    difficulty: 'easy' | 'medium' | 'hard' = 'medium',
    maxRounds: number = 1
  ): GameState {
    const bots: RoomPlayer[] = [
      { id: `bot-1-${Date.now()}`, name: 'CYAN BOT', avatar: 'bot-1', isHost: false, isReady: true, isAI: true, aiDifficulty: difficulty },
      { id: `bot-2-${Date.now()}`, name: 'APEX BOT', avatar: 'bot-2', isHost: false, isReady: true, isAI: true, aiDifficulty: difficulty },
      { id: `bot-3-${Date.now()}`, name: 'NEXUS BOT', avatar: 'bot-3', isHost: false, isReady: true, isAI: true, aiDifficulty: difficulty },
    ];

    const allRoomPlayers = [
      { id: humanPlayer.id, name: humanPlayer.name, avatar: humanPlayer.avatar, isHost: true, isReady: true, isAI: false },
      ...bots,
    ];

    return this.initGameState(`game-sp-${Date.now()}`, allRoomPlayers, maxRounds);
  }

  initGameState(gameId: string, roomPlayers: RoomPlayer[], maxRounds: number = 1): GameState {
    const deck = shuffleDeck(createDeck());
    const hands = dealCards(deck);

    const players: Player[] = roomPlayers.map((rp, index) => ({
      id: rp.id,
      name: rp.name,
      isAI: rp.isAI,
      aiDifficulty: rp.aiDifficulty || 'medium',
      avatar: rp.avatar,
      seat: index,
      cards: hands[index],
      call: null,
      tricksWon: 0,
      totalScore: 0,
      roundScores: [],
      isOnline: true,
    }));

    const state: GameState = {
      id: gameId,
      phase: 'bidding',
      currentRound: 1,
      maxRounds: Math.max(1, maxRounds),
      currentTurnSeat: 0,
      dealerSeat: 0,
      players,
      currentTrick: {
        trickNumber: 1,
        leadSuit: null,
        cards: [],
        winnerId: null,
      },
      trickHistory: [],
      roundResults: [],
      winnerId: null,
    };

    this.games.set(gameId, state);
    return state;
  }

  getGame(key: string): GameState | undefined {
    if (this.games.has(key)) return this.games.get(key);
    for (const [k, g] of this.games.entries()) {
      if (k === key || k.endsWith(key) || g.id === key) return g;
    }
    return undefined;
  }

  private startTurnTimer(roomCode: string) {
    const existing = this.turnTimers.get(roomCode);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.handleTurnTimeout(roomCode);
    }, 20000); // Strict 20-second timeout per turn

    this.turnTimers.set(roomCode, timer);
  }

  private handleTurnTimeout(roomCode: string) {
    const game = this.getGame(roomCode);
    if (!game) return;

    const currentPlayer = game.players[game.currentTurnSeat];
    if (!currentPlayer) return;

    if (game.phase === 'bidding') {
      if (currentPlayer.isAI) {
        if (currentPlayer.call === null) {
          currentPlayer.call = calculateAICall(currentPlayer.cards, currentPlayer.aiDifficulty || 'medium');
        }
      } else if (currentPlayer.call === null) {
        currentPlayer.call = calculateAICall(currentPlayer.cards, 'medium');
      }

      if (!game.players.every((p) => p.call !== null)) return;

      game.phase = 'playing';
      game.currentTurnSeat = (game.dealerSeat + 1) % 4;
      game.currentTrick = {
        trickNumber: 1,
        leadSuit: null,
        cards: [],
        winnerId: null,
      };
      this.notifyStateChange(roomCode, game);
      this.startTurnTimer(roomCode);
      this.checkAndProcessAITurn(game);
      return;
    }

    if (game.phase === 'playing' && currentPlayer.cards.length > 0) {
      const bestCard = selectAICard(
        currentPlayer.cards,
        game.currentTrick.leadSuit,
        game.currentTrick.cards,
        currentPlayer.call || 1,
        currentPlayer.tricksWon,
        currentPlayer.aiDifficulty || 'medium',
        currentPlayer.id
      );
      this.playCard(roomCode, currentPlayer.id, bestCard.id);
    }
  }

  submitCall(gameKey: string, playerId: string, callValue: number): GameState {
    const game = this.getGame(gameKey);
    if (!game) throw new Error('Game not found');
    if (game.phase !== 'bidding') return game;

    const player = game.players.find((p) => p.id === playerId);
    if (player) {
      player.call = callValue;
    }

    // Instantly calculate all AI calls
    game.players.forEach((p) => {
      if (p.isAI && p.call === null) {
        p.call = calculateAICall(p.cards, p.aiDifficulty);
      }
    });

    const allCalled = game.players.every((p) => p.call !== null);
    if (allCalled) {
      game.phase = 'playing';
      game.currentTurnSeat = (game.dealerSeat + 1) % 4;
      game.currentTrick = {
        trickNumber: 1,
        leadSuit: null,
        cards: [],
        winnerId: null,
      };
      this.startTurnTimer(gameKey);
    }

    this.notifyStateChange(game.id, game);
    this.checkAndProcessAITurn(game);
    return game;
  }

  playCard(gameKey: string, playerId: string, cardId: string): GameState {
    const game = this.getGame(gameKey);
    if (!game) throw new Error('Game not found');
    if (game.phase !== 'playing') return game;

    // Prevent playing extra cards while 4 cards are currently being resolved
    if (game.currentTrick.cards.length >= 4) return game;

    const currentPlayer = game.players[game.currentTurnSeat];
    if (currentPlayer.id !== playerId) throw new Error('Not your turn to play');

    const cardIndex = currentPlayer.cards.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) throw new Error('Card not in hand');

    const card = currentPlayer.cards[cardIndex];

    const isValid = isValidMove(
      card.id,
      currentPlayer.cards,
      game.currentTrick.leadSuit,
      game.currentTrick.cards
    );

    if (!isValid) {
      throw new Error('Illegal card play according to Call Break rules');
    }

    // Cancel active turn timer immediately upon valid card play
    const activeTimer = this.turnTimers.get(game.id) || this.turnTimers.get(gameKey);
    if (activeTimer) {
      clearTimeout(activeTimer);
      this.turnTimers.delete(game.id);
      this.turnTimers.delete(gameKey);
    }

    // Remove played card from player's hand
    currentPlayer.cards.splice(cardIndex, 1);

    if (game.currentTrick.cards.length === 0) {
      game.currentTrick.leadSuit = card.suit;
    }

    game.currentTrick.cards.push({ playerId: currentPlayer.id, card });

    if (game.currentTrick.cards.length === 4) {
      const winnerId = determineTrickWinner(
        game.currentTrick.cards,
        game.currentTrick.leadSuit!
      );
      game.currentTrick.winnerId = winnerId;
      const winnerPlayer = game.players.find((p) => p.id === winnerId);
      if (winnerPlayer) winnerPlayer.tricksWon += 1;

      this.notifyStateChange(game.id, game);

      setTimeout(() => {
        this.resolveCompletedTrick(game);
      }, 1400);
    } else {
      game.currentTurnSeat = (game.currentTurnSeat + 1) % 4;
      this.startTurnTimer(gameKey);
      this.notifyStateChange(game.id, game);
      this.checkAndProcessAITurn(game);
    }

    return game;
  }

  private resolveCompletedTrick(game: GameState) {
    if (game.phase !== 'playing') return;
    if (game.currentTrick.cards.length !== 4) return;

    game.trickHistory.push({ ...game.currentTrick });

    const totalPlayedCards = game.trickHistory.length * 4;
    const allHandsEmpty = game.players.every((p) => p.cards.length === 0);
    const isRoundFinished =
      game.trickHistory.length >= 13 || totalPlayedCards >= 52 || allHandsEmpty;

    if (isRoundFinished) {
      // Ensure all player hands are strictly empty at round completion
      game.players.forEach((p) => {
        p.cards = [];
      });
      this.finishRound(game);
    } else {
      const winnerPlayer = game.players.find((p) => p.id === game.currentTrick.winnerId);
      const winnerSeat = winnerPlayer ? winnerPlayer.seat : game.currentTurnSeat;
      const nextTrickNum = game.trickHistory.length + 1;

      game.currentTurnSeat = winnerSeat;
      game.currentTrick = {
        trickNumber: nextTrickNum,
        leadSuit: null,
        cards: [],
        winnerId: null,
      };
      this.startTurnTimer(game.id);
      this.notifyStateChange(game.id, game);
      this.checkAndProcessAITurn(game);
    }
  }

  private finishRound(game: GameState) {
    const timer = this.turnTimers.get(game.id);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(game.id);
    }

    // Ensure all player hands are strictly empty
    game.players.forEach((p) => {
      p.cards = [];
    });

    const roundScores = calculateRoundScores(game.players);
    game.roundResults.push({
      roundNumber: game.currentRound,
      scores: roundScores,
    });

    for (const player of game.players) {
      const pScore = roundScores[player.id]?.score || 0;
      player.roundScores.push(pScore);
      player.totalScore = Math.round((player.totalScore + pScore) * 10) / 10;
    }

    if (game.currentRound < game.maxRounds) {
      game.phase = 'round_end';
    } else {
      game.phase = 'game_over';
      let topPlayer = game.players[0];
      for (const p of game.players) {
        if (p.totalScore > topPlayer.totalScore) {
          topPlayer = p;
        }
      }
      game.winnerId = topPlayer.id;
    }

    this.notifyStateChange(game.id, game);
  }

  public checkAndProcessAITurn(game: GameState) {
    if (game.phase !== 'playing') return;

    const currentPlayer = game.players[game.currentTurnSeat];
    if (!currentPlayer || !currentPlayer.isAI) return;

    const gameId = game.id;
    const turnSeat = game.currentTurnSeat;

    setTimeout(() => {
      try {
        const freshGame = this.getGame(gameId);
        if (!freshGame || freshGame.phase !== 'playing') return;
        if (freshGame.currentTurnSeat !== turnSeat) return;
        if (freshGame.currentTrick.cards.length >= 4) return;

        const turnPlayer = freshGame.players[turnSeat];
        if (!turnPlayer?.isAI) return;

        const card = selectAICard(
          turnPlayer.cards,
          freshGame.currentTrick.leadSuit,
          freshGame.currentTrick.cards,
          turnPlayer.call || 1,
          turnPlayer.tricksWon,
          turnPlayer.aiDifficulty || 'medium',
          turnPlayer.id
        );
        this.playCard(gameId, turnPlayer.id, card.id);
      } catch (err) {
        console.error('Error processing AI turn:', err);
      }
    }, 1100);
  }
}

export const roomManager = new RoomManager();
