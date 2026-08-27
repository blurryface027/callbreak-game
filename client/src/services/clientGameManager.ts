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

export class ClientGameManager {
  private rooms: Map<string, Room> = new Map();

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
    this.rooms.set(room.code, room);
    return room;
  }

  joinRoom(code: string, player: { id: string; name: string; avatar: string }): Room {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) {
      return this.createRoom(player);
    }
    if (!room.players.some((p) => p.id === player.id)) {
      room.players.push({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        isHost: false,
        isReady: false,
        isAI: false,
      });
    }
    return room;
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

    const allRoomPlayers: RoomPlayer[] = [
      { id: humanPlayer.id, name: humanPlayer.name, avatar: humanPlayer.avatar, isHost: true, isReady: true, isAI: false },
      ...bots,
    ];

    return this.initGameState(`game-sp-${Date.now()}`, allRoomPlayers, maxRounds);
  }

  /** Full rematch reset: same players/settings, fresh scores, deal, and round state. */
  restartMatch(game: GameState): GameState {
    const roomPlayers: RoomPlayer[] = game.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: !p.isAI,
      isReady: true,
      isAI: p.isAI,
      aiDifficulty: p.aiDifficulty || 'medium',
    }));

    return this.initGameState(`game-sp-${Date.now()}`, roomPlayers, game.maxRounds);
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

    return state;
  }

  submitCall(game: GameState, playerId: string, callValue: number): GameState {
    if (game.phase !== 'bidding') return game;

    const player = game.players.find((p) => p.id === playerId);
    if (player) {
      player.call = callValue;
    }

    // Instantly calculate all AI calls so the game starts immediately
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
    }

    return { ...game };
  }

  playCard(game: GameState, playerId: string, cardId: string): GameState {
    if (game.phase !== 'playing') return game;
    if (game.currentTrick.cards.length >= 4) return game;

    const currentPlayer = game.players[game.currentTurnSeat];
    if (!currentPlayer || currentPlayer.id !== playerId) return game;

    const cardIndex = currentPlayer.cards.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return game;

    const card = currentPlayer.cards[cardIndex];
    const isValid = isValidMove(
      card.id,
      currentPlayer.cards,
      game.currentTrick.leadSuit,
      game.currentTrick.cards
    );

    if (!isValid) return game;

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
      if (winnerPlayer) {
        winnerPlayer.tricksWon += 1;
      }
      game.currentTurnSeat = winnerPlayer ? winnerPlayer.seat : 0;
    } else {
      game.currentTurnSeat = (game.currentTurnSeat + 1) % 4;
    }

    return { ...game };
  }

  private finishRound(game: GameState) {
    // Ensure all player hands are strictly empty at round completion
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
  }

  public startNextRound(game: GameState): GameState {
    if (game.phase === 'game_over' || game.currentRound >= game.maxRounds) {
      return this.restartMatch(game);
    }

    game.currentRound += 1;
    game.dealerSeat = (game.dealerSeat + 1) % 4;
    game.currentTurnSeat = (game.dealerSeat + 1) % 4;
    game.phase = 'bidding';
    game.winnerId = null;
    game.trickHistory = [];
    game.currentTrick = {
      trickNumber: 1,
      leadSuit: null,
      cards: [],
      winnerId: null,
    };

    const deck = shuffleDeck(createDeck());
    const hands = dealCards(deck);

    game.players.forEach((p, idx) => {
      p.cards = hands[idx];
      p.call = null;
      p.tricksWon = 0;
    });

    return { ...game };
  }

  public processNextAITurn(game: GameState): GameState | null {
    if (game.phase !== 'bidding' && game.phase !== 'playing') return null;

    const currentPlayer = game.players[game.currentTurnSeat];
    if (!currentPlayer?.isAI) return null;

    if (game.phase === 'bidding' && currentPlayer.call === null) {
      const aiCall = calculateAICall(currentPlayer.cards, currentPlayer.aiDifficulty);
      currentPlayer.call = aiCall;
      game.currentTurnSeat = (game.currentTurnSeat + 1) % 4;

      if (game.players.every((p) => p.call !== null)) {
        game.phase = 'playing';
        game.currentTurnSeat = (game.dealerSeat + 1) % 4;
        game.currentTrick = {
          trickNumber: 1,
          leadSuit: null,
          cards: [],
          winnerId: null,
        };
      }

      return { ...game };
    }

    if (game.phase === 'playing') {
      const card = selectAICard(
        currentPlayer.cards,
        game.currentTrick.leadSuit,
        game.currentTrick.cards,
        currentPlayer.call || 1,
        currentPlayer.tricksWon,
        currentPlayer.aiDifficulty,
        currentPlayer.id
      );

      const cardIdx = currentPlayer.cards.findIndex((c) => c.id === card.id);
      if (cardIdx === -1) return null;

      currentPlayer.cards.splice(cardIdx, 1);
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

        game.currentTurnSeat = winnerPlayer ? winnerPlayer.seat : 0;
      } else {
        game.currentTurnSeat = (game.currentTurnSeat + 1) % 4;
      }

      return { ...game };
    }

    return null;
  }

  public resolveCompletedTrick(game: GameState): GameState | null {
    if (game.phase !== 'playing') return null;
    if (game.currentTrick.cards.length !== 4 || !game.currentTrick.winnerId) return null;

    game.trickHistory.push({ ...game.currentTrick });

    const totalPlayedCards = game.trickHistory.length * 4;
    const allHandsEmpty = game.players.every((p) => p.cards.length === 0);
    const isRoundFinished =
      game.trickHistory.length >= 13 || totalPlayedCards >= 52 || allHandsEmpty;

    if (isRoundFinished) {
      game.players.forEach((p) => {
        p.cards = [];
      });
      this.finishRound(game);
    } else {
      const winnerPlayer = game.players.find((p) => p.id === game.currentTrick.winnerId);
      const nextTrickNum = game.trickHistory.length + 1;

      game.currentTurnSeat = winnerPlayer ? winnerPlayer.seat : 0;
      game.currentTrick = {
        trickNumber: nextTrickNum,
        leadSuit: null,
        cards: [],
        winnerId: null,
      };
    }

    return { ...game };
  }
}

export const clientGameManager = new ClientGameManager();
