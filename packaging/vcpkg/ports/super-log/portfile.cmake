# vcpkg port for the super-log SDK.
#
# Default: the C header (sdk/c/superlog.h) - genuinely standalone, node
# builtins nowhere, one file, zero dependencies.
#
# [cpp]: the header-only C++ SDK (sdk/cpp/include/super_log) - the event
# model and SN_LOG. The core depends only on ts-moveables (now a vcpkg
# port). The spdlog sink header (super_log/spdlog_sink.hpp) is installed
# too, but spdlog is the consumer's choice: add the [spdlog] feature, or
# your own find_package(spdlog), to compile it.
#
# The hub daemon and the Node tailers are NOT vcpkg artifacts (an app and a
# JS runtime); they ship via apt/brew/source. vcpkg carries the SDK you link.

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO saxonnicholls/super-log
    REF "v${VERSION}"
    SHA512 fdb766cb09a40fb8d1f9005289deadf5d5bd240321f109c764a458ca2a50f5b2fa701d88b8e368b9af73ad1da25867fb0271a9d8f4953f6bc2a03ec992c60eb9
    HEAD_REF main
)

# The C SDK - always.
file(INSTALL "${SOURCE_PATH}/sdk/c/superlog.h"
     DESTINATION "${CURRENT_PACKAGES_DIR}/include")

if("cpp" IN_LIST FEATURES)
    # The C++ SDK headers (header-only).
    file(INSTALL "${SOURCE_PATH}/sdk/cpp/include/super_log"
         DESTINATION "${CURRENT_PACKAGES_DIR}/include")

    # A package config exposing superlog::cpp: find_package(super-log CONFIG)
    # then target_link_libraries(app PRIVATE superlog::cpp). ts-moveables is the
    # only hard dependency; spdlog (for the sink) is left to the consumer / the
    # [spdlog] feature so the core SDK never forces it.
    set(_config_dir "${CURRENT_PACKAGES_DIR}/share/${PORT}")
    file(WRITE "${_config_dir}/super-logConfig.cmake"
"include(CMakeFindDependencyMacro)
find_dependency(ts_moveables CONFIG)
get_filename_component(_superlog_prefix \"\${CMAKE_CURRENT_LIST_DIR}/../..\" ABSOLUTE)
if(NOT TARGET superlog::cpp)
    add_library(superlog::cpp INTERFACE IMPORTED)
    set_target_properties(superlog::cpp PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES \"\${_superlog_prefix}/include\"
        INTERFACE_COMPILE_FEATURES cxx_std_17
        INTERFACE_LINK_LIBRARIES snicholls::ts_moveables)
    if(WIN32)
        # The transport uses Winsock on Windows (MSVC also auto-links via a
        # pragma, but be explicit for clang-cl / MinGW consumers).
        set_property(TARGET superlog::cpp APPEND PROPERTY INTERFACE_LINK_LIBRARIES ws2_32)
    endif()
endif()
unset(_superlog_prefix)
")
    file(WRITE "${_config_dir}/super-logConfigVersion.cmake"
"set(PACKAGE_VERSION \"${VERSION}\")
if(PACKAGE_VERSION VERSION_LESS PACKAGE_FIND_VERSION)
    set(PACKAGE_VERSION_COMPATIBLE FALSE)
else()
    set(PACKAGE_VERSION_COMPATIBLE TRUE)
    if(PACKAGE_VERSION VERSION_EQUAL PACKAGE_FIND_VERSION)
        set(PACKAGE_VERSION_EXACT TRUE)
    endif()
endif()
")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/usage"
"super-log SDK.

C (header-only, zero deps):
    #define SUPERLOG_DEVELOPMENT   // or SUPERLOG_PRODUCTION - exactly one
    #include <superlog.h>

C++ (the [cpp] feature):
    find_package(super-log CONFIG REQUIRED)
    target_link_libraries(main PRIVATE superlog::cpp)

The spdlog sink (super_log/spdlog_sink.hpp) needs spdlog - install
super-log[cpp,spdlog], or add find_package(spdlog) yourself.

The hub daemon and the Node tailers ship via apt / brew / source, not vcpkg.
")
