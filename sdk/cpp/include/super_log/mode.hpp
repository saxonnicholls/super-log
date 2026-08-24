//
//  mode.hpp
//  super-log C++ SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The mode switch and the policy that rides on it.
//
//  Mode: every consumer declares its build - define exactly one of
//  SUPERLOG_DEVELOPMENT / SUPERLOG_PRODUCTION. Neither flag, or both, is a
//  compile error on purpose: a logging pipeline you *think* is off is worse
//  than one that will not build until you decide. (In this repo's own build
//  the CMake cache variable SUPER_LOG_MODE supplies the define.)
//
//  Policy: what each mode actually ships. SUPERLOG_DEV_POLICY and
//  SUPERLOG_PROD_POLICY name the minimum level that is forwarded in that
//  mode - TRACE DEBUG INFO WARN ERROR CRITICAL, or OFF for nothing at all.
//  Defaults: development ships everything, production ships NOTHING -
//  loosen production deliberately (-DSUPERLOG_PROD_POLICY=ERROR ships only
//  ERROR and CRITICAL), never by accident; log lines leaving a production
//  box are a security decision, not a default. The active mode picks its
//  policy at compile time; a below-policy event is not serialised, not
//  queued, not anything, and a policy of OFF compiles the whole transport
//  to an inert shell (no worker thread, no sockets).
//

#ifndef super_log_mode_hpp
#define super_log_mode_hpp

#if defined(SUPERLOG_DEVELOPMENT) && defined(SUPERLOG_PRODUCTION)
#error "super-log: SUPERLOG_DEVELOPMENT and SUPERLOG_PRODUCTION are both defined - define exactly one"
#endif
#if !defined(SUPERLOG_DEVELOPMENT) && !defined(SUPERLOG_PRODUCTION)
#error "super-log: define exactly one of SUPERLOG_DEVELOPMENT / SUPERLOG_PRODUCTION (the bench wants -DSUPERLOG_DEVELOPMENT)"
#endif

// Ranks are 1-based so an unknown policy name expands to 0 and is caught
// below, instead of silently becoming "ship everything".
#define SUPERLOG_LEVEL_TRACE    1
#define SUPERLOG_LEVEL_DEBUG    2
#define SUPERLOG_LEVEL_INFO     3
#define SUPERLOG_LEVEL_WARN     4
#define SUPERLOG_LEVEL_ERROR    5
#define SUPERLOG_LEVEL_CRITICAL 6
#define SUPERLOG_LEVEL_OFF      7

#ifndef SUPERLOG_DEV_POLICY
#define SUPERLOG_DEV_POLICY TRACE
#endif
#ifndef SUPERLOG_PROD_POLICY
#define SUPERLOG_PROD_POLICY OFF
#endif

#define SUPERLOG_POLICY_RANK_(x) SUPERLOG_LEVEL_##x
#define SUPERLOG_POLICY_RANK(x) SUPERLOG_POLICY_RANK_(x)

#ifdef SUPERLOG_DEVELOPMENT
#define SUPERLOG_MIN_LEVEL SUPERLOG_POLICY_RANK(SUPERLOG_DEV_POLICY)
#else
#define SUPERLOG_MIN_LEVEL SUPERLOG_POLICY_RANK(SUPERLOG_PROD_POLICY)
#endif

#if SUPERLOG_MIN_LEVEL < SUPERLOG_LEVEL_TRACE || SUPERLOG_MIN_LEVEL > SUPERLOG_LEVEL_OFF
#error "super-log: policy must be one of TRACE DEBUG INFO WARN ERROR CRITICAL OFF"
#endif

#define SUPERLOG_ENABLED (SUPERLOG_MIN_LEVEL < SUPERLOG_LEVEL_OFF)

#endif /* super_log_mode_hpp */
