'use client';

import { useEffect, useRef } from 'react';
import { getPusherClient } from './pusher-client';

/**
 * Subscribe to a Pusher channel and bind to an event.
 * Automatically cleans up on unmount.
 */
export function usePusherEvent(channelName, eventName, callback) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher || !channelName || !eventName) return;

    const channel = pusher.subscribe(channelName);

    const handler = (data) => {
      callbackRef.current(data);
    };

    channel.bind(eventName, handler);

    return () => {
      channel.unbind(eventName, handler);
      pusher.unsubscribe(channelName);
    };
  }, [channelName, eventName]);
}
