//
//  @super-log/react
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  The provider pattern over @super-log/client: wrap the tree once and
//  every error in it reaches the bench, with the component stack that says
//  *which* component - the thing a raw JS stack cannot tell you.
//
//      <SuperLogProvider options={{url, topic, app, development: __DEV__,
//                                  production: !__DEV__}}>
//        <App />
//      </SuperLogProvider>
//
//  The provider installs the runtime's global hooks (uncaught exceptions,
//  unhandled rejections) AND acts as an error boundary, because those are
//  different failures: a global hook catches what escapes the whole
//  program, a boundary catches what a render threw - React swallows those
//  and unmounts the tree, so they never reach a global hook at all.
//
//  Written with createElement rather than JSX so the package builds with
//  plain tsc and no bundler; React is a peer dependency, never bundled.
//

import { Component, createContext, createElement, useContext, useEffect, useRef } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';
import { createSuperLog, type SuperLog, type SuperLogOptions } from '@super-log/client';

const Ctx = createContext<SuperLog | null>(null);

/** The client for this tree. Throws outside a provider, because a silent
 *  no-op logger is the bug you find three days later. */
export function useSuperLog(): SuperLog {
  const log = useContext(Ctx);
  if (!log) throw new Error('useSuperLog must be used inside <SuperLogProvider>');
  return log;
}

/** Log every render error under this boundary, then let `fallback` (or
 *  nothing) take the place of the subtree. Without a boundary React
 *  unmounts the whole tree on a render error and the bench never hears. */
export class SuperLogErrorBoundary extends Component<
  { log?: SuperLog; children?: ReactNode; fallback?: ReactNode; name?: string },
  { failed: boolean }
> {
  static contextType = Ctx;
  declare context: SuperLog | null;
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const log = this.props.log ?? this.context;
    // componentStack is the payload that matters here: it names the
    // component that threw, which no JS stack contains.
    log?.exception(error, 'react-render', {
      boundary: this.props.name ?? 'SuperLogErrorBoundary',
      component_stack: (info.componentStack ?? '').split('\n').slice(0, 20).join('\n').trim(),
    });
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

export interface SuperLogProviderProps {
  options: SuperLogOptions;
  children?: ReactNode;
  /** Shown when a render under this provider throws. Default: nothing,
   *  which matches React's own unmount-the-subtree behaviour. */
  fallback?: ReactNode;
  /** Set false to provide the client without wrapping in a boundary. */
  boundary?: boolean;
}

/** One client for the tree, its global error hooks installed for as long
 *  as the tree is mounted, and (by default) an error boundary around the
 *  children. */
export function SuperLogProvider({
  options,
  children,
  fallback,
  boundary = true,
}: SuperLogProviderProps) {
  // Created once: a client per render would leak a timer per render, and
  // the session id is meant to identify this app run.
  const ref = useRef<SuperLog | null>(null);
  if (!ref.current) ref.current = createSuperLog(options);
  const log = ref.current;

  useEffect(() => {
    // The constructor already installed these unless captureUncaught:false;
    // this is the unmount half, so a hot reload does not stack handlers.
    const undo = log.captureUncaught();
    return () => {
      undo();
      void log.flush();
    };
  }, [log]);

  const inner = boundary
    ? createElement(SuperLogErrorBoundary, { log, fallback }, children)
    : children;
  return createElement(Ctx.Provider, { value: log }, inner);
}

/** Wrap one component in its own boundary, so a failure there does not
 *  take out the rest of the screen. */
export function withSuperLogBoundary<P extends object>(
  Wrapped: ComponentType<P>,
  opts: { name?: string; fallback?: ReactNode } = {},
): ComponentType<P> {
  const Boundaried = (props: P) =>
    createElement(
      SuperLogErrorBoundary,
      { name: opts.name ?? Wrapped.displayName ?? Wrapped.name, fallback: opts.fallback },
      createElement(Wrapped, props),
    );
  Boundaried.displayName = `withSuperLogBoundary(${Wrapped.displayName ?? Wrapped.name ?? 'Component'})`;
  return Boundaried;
}

export type { SuperLog, SuperLogOptions };
