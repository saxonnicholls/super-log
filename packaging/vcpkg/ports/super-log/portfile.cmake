# vcpkg port for the super-log C SDK.
#
# Scoped to the C header (sdk/c/superlog.h) ON PURPOSE: it is genuinely
# standalone - node builtins nowhere, one file, zero dependencies - so it
# is a clean vcpkg package. The C++ SDK is NOT here: it includes
# ts-moveables headers directly, and ts-moveables is not (yet) a vcpkg
# port, so shipping the C++ SDK through vcpkg would mean shipping a
# broken find. A C++ consumer that wants the full spdlog sink uses
# find_package(superlog) from a source/brew install instead; a consumer
# that wants "log to the hub from C or C++ with no deps" wants exactly
# this header.
#
# Header-only: no build, just place the header and the usage/license.

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO saxonnicholls/super-log
    REF "v${VERSION}"
    SHA512 0  # replace with the real SHA512 at publish (vcpkg prints it on first run)
    HEAD_REF main
)

file(INSTALL "${SOURCE_PATH}/sdk/c/superlog.h"
     DESTINATION "${CURRENT_PACKAGES_DIR}/include")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/usage"
"super-log C SDK (header-only):

    #define SUPERLOG_DEVELOPMENT   // or SUPERLOG_PRODUCTION - exactly one
    #include <superlog.h>

    superlog_t lg; superlog_init(&lg, \"c.myapp\", \"myapp\");
    superlog_logf(&lg, \"INFO\", \"up on %d\", port);
    superlog_flush(&lg);

The C++ SDK (spdlog sink, native SN_LOG) ships via find_package(superlog)
from a source or Homebrew install - it depends on ts-moveables, which is
not a vcpkg port.
")
