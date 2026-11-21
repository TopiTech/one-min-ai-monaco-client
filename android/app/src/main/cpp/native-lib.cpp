#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "node.h"

namespace {

constexpr const char* LOG_TAG = "NODEJS-MOBILE";
int pfd_stdout[2];
int pfd_stderr[2];
pthread_t thread_stdout;
pthread_t thread_stderr;
std::atomic<bool> redirect_started{false};

void* thread_stderr_func(void*) {
    ssize_t read_size;
    char buf[2048];
    while ((read_size = read(pfd_stderr[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[read_size - 1] == '\n') {
            --read_size;
        }
        buf[read_size] = '\0';
        __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, buf);
    }
    return nullptr;
}

void* thread_stdout_func(void*) {
    ssize_t read_size;
    char buf[2048];
    while ((read_size = read(pfd_stdout[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[read_size - 1] == '\n') {
            --read_size;
        }
        buf[read_size] = '\0';
        __android_log_write(ANDROID_LOG_INFO, LOG_TAG, buf);
    }
    return nullptr;
}

void start_redirecting_stdout_stderr() {
    if (redirect_started.exchange(true)) {
        return;
    }

    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);

    if (pipe(pfd_stdout) == 0) {
        dup2(pfd_stdout[1], STDOUT_FILENO);
        pthread_create(&thread_stdout, nullptr, thread_stdout_func, nullptr);
        pthread_detach(thread_stdout);
    }

    if (pipe(pfd_stderr) == 0) {
        dup2(pfd_stderr[1], STDERR_FILENO);
        pthread_create(&thread_stderr, nullptr, thread_stderr_func, nullptr);
        pthread_detach(thread_stderr);
    }
}

std::string jstring_to_std_string(JNIEnv* env, jstring jstr) {
    if (!jstr) return {};
    const char* raw = env->GetStringUTFChars(jstr, nullptr);
    if (!raw) return {};
    std::string result(raw);
    env->ReleaseStringUTFChars(jstr, raw);
    return result;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_topitech_oneminai_MainActivity_startNodeWithArguments(
    JNIEnv* env,
    jobject /* this */,
    jobjectArray arguments,
    jstring nodeProjectDir,
    jstring cacheDir,
    jstring workspaceDir
) {
    start_redirecting_stdout_stderr();

    const std::string project_dir = jstring_to_std_string(env, nodeProjectDir);
    const std::string cache_dir = jstring_to_std_string(env, cacheDir);
    const std::string workspace_dir = jstring_to_std_string(env, workspaceDir);

    setenv("APP_PLATFORM", "android", 1);
    setenv("NODE_ENV", "production", 1);
    setenv("PORT", "38517", 1);
    setenv("LOG_TO_FILE", "false", 1);
    setenv("ENABLE_COMMAND_EXECUTION", "false", 1);
    setenv("ENABLE_CODE_RUN", "false", 1);

    if (!cache_dir.empty()) {
        setenv("TMPDIR", cache_dir.c_str(), 1);
    }
    if (!workspace_dir.empty()) {
        setenv("ALLOWED_ROOTS", workspace_dir.c_str(), 1);
    }
    if (!project_dir.empty()) {
        chdir(project_dir.c_str());
    }

    jsize argument_count = env->GetArrayLength(arguments);
    std::vector<std::string> arg_strings;
    arg_strings.reserve(static_cast<size_t>(argument_count));

    size_t total_bytes = 0;
    for (jsize i = 0; i < argument_count; ++i) {
        auto j_arg = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        std::string arg = jstring_to_std_string(env, j_arg);
        env->DeleteLocalRef(j_arg);
        total_bytes += arg.size() + 1;
        arg_strings.push_back(std::move(arg));
    }

    // uv_setup_args requires argv strings to live in one contiguous buffer.
    std::vector<char> contiguous_buffer(total_bytes > 0 ? total_bytes : 1, '\0');
    std::vector<char*> argv(static_cast<size_t>(argument_count), nullptr);
    size_t offset = 0;
    for (jsize i = 0; i < argument_count; ++i) {
        const auto& s = arg_strings[static_cast<size_t>(i)];
        argv[static_cast<size_t>(i)] = contiguous_buffer.data() + offset;
        std::memcpy(contiguous_buffer.data() + offset, s.c_str(), s.size() + 1);
        offset += s.size() + 1;
    }

    return static_cast<jint>(node::Start(static_cast<int>(argument_count), argv.data()));
}
