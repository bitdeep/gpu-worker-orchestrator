# Attribution and boundaries

The orchestration and client integration code is provided under the MIT license in this repository. It does not implement or redistribute the model runtimes or model weights.

The adapters target [vLLM](https://github.com/vllm-project/vllm), [Speaches](https://github.com/speaches-ai/speaches), [Kokoro FastAPI](https://github.com/remsky/Kokoro-FastAPI), the [Chatterbox server API](https://github.com/devnen/Chatterbox-TTS-Server), [Qwen3 TTS Server](https://github.com/malaiwah/qwen3-tts-server) and [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference). Those projects and their model weights have their own licenses.

FFmpeg is invoked as a separate system executable for audio conversion; it is not bundled in the JavaScript release. Deployments must account for the license of their chosen FFmpeg build.

Development dependencies are pinned in `package.json` and `pnpm-lock.yaml`. Their source and license metadata remain in their upstream packages; no development dependency is included in the local release.
