# The native viewer: Dear ImGui + GLFW, feed via ts-moveables' websocket
# client. imgui and glfw come from third_party/ submodules (pinned v1.91.5
# and 3.4) so a configure needs no network; FetchContent is the fallback for
# a checkout cloned without --recurse-submodules.

if(SUPER_LOG_HAS_VENDORED_IMGUI)
    set(imgui_SOURCE_DIR "${SUPER_LOG_THIRD_PARTY}/imgui")
    set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    add_subdirectory("${SUPER_LOG_THIRD_PARTY}/glfw" glfw EXCLUDE_FROM_ALL)
else()
    include(FetchContent)
    FetchContent_Declare(imgui
        GIT_REPOSITORY https://github.com/ocornut/imgui.git
        GIT_TAG v1.91.5)
    FetchContent_Declare(glfw
        GIT_REPOSITORY https://github.com/glfw/glfw.git
        GIT_TAG 3.4)
    set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(imgui glfw)
endif()

if(NOT SUPER_LOG_HAS_NLOHMANN)
    include(FetchContent)
    set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(nlohmann_json
        GIT_REPOSITORY https://github.com/nlohmann/json.git
        GIT_TAG v3.12.0)
    FetchContent_MakeAvailable(nlohmann_json)
endif()

add_executable(superlog_viewer
    src/main.cpp
    ${imgui_SOURCE_DIR}/imgui.cpp
    ${imgui_SOURCE_DIR}/imgui_draw.cpp
    ${imgui_SOURCE_DIR}/imgui_tables.cpp
    ${imgui_SOURCE_DIR}/imgui_widgets.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp)

target_include_directories(superlog_viewer PRIVATE
    ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(superlog_viewer PRIVATE
    snicholls::ts_moveables glfw nlohmann_json::nlohmann_json)
target_compile_features(superlog_viewer PRIVATE cxx_std_17)

if(APPLE)
    target_link_libraries(superlog_viewer PRIVATE "-framework OpenGL")
    # OpenGL is deprecated-not-removed on macOS; fine for a dev tool
    target_compile_definitions(superlog_viewer PRIVATE GL_SILENCE_DEPRECATION)
else()
    find_package(OpenGL REQUIRED)
    target_link_libraries(superlog_viewer PRIVATE OpenGL::GL)
endif()
