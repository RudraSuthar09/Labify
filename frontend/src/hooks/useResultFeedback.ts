/**
 * Audio + haptic feedback for a verification result.
 *
 * Critical in noisy factory environments where the operator may not be looking
 * at the screen: a bright beep on PASS, a low buzz on FAIL, plus a matching
 * notification haptic. Sound is caller-toggleable; haptics always fire.
 *
 * expo-audio's player is created via a hook, so this must be used at the top
 * level of a component.
 */
import { useCallback, useEffect } from 'react';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as Haptics from 'expo-haptics';

import type { VerificationStatus } from '../types/verification';

// Bundled at build time; paths are relative to this file.
const beepSrc = require('../../assets/sounds/beep.wav');
const buzzSrc = require('../../assets/sounds/buzz.wav');

export type PlayFeedback = (
  status: VerificationStatus,
  soundEnabled: boolean,
) => void;

export function useResultFeedback(): PlayFeedback {
  const beep = useAudioPlayer(beepSrc);
  const buzz = useAudioPlayer(buzzSrc);

  useEffect(() => {
    // Let the alert tones sound even when the phone's ringer is on silent.
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {
      /* non-fatal */
    });
  }, []);

  return useCallback(
    (status: VerificationStatus, soundEnabled: boolean) => {
      // Haptics — no-op on hardware without a haptic engine, so guard nothing.
      const hapticType =
        status === 'pass'
          ? Haptics.NotificationFeedbackType.Success
          : status === 'warning'
            ? Haptics.NotificationFeedbackType.Warning
            : Haptics.NotificationFeedbackType.Error;
      Haptics.notificationAsync(hapticType).catch(() => {
        /* non-fatal */
      });

      if (!soundEnabled) return;

      // FAIL gets the low buzz; PASS and WARNING get the bright beep.
      const player = status === 'fail' ? buzz : beep;
      try {
        // expo-audio leaves the player at the end after playing; rewind first.
        player.seekTo(0);
        player.play();
      } catch {
        /* non-fatal */
      }
    },
    [beep, buzz],
  );
}

export default useResultFeedback;
