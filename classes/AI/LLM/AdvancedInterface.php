<?php

/**
 * AI_LLM_AdvancedInterface
 *
 * Optional interface implemented by providers that support cache control,
 * prefix prewarming, and other expert-level features beyond the common
 * executeModel surface.
 *
 * Local model adapters (vLLM, llama-cpp-server, etc.) fully implement this.
 * Hosted providers may partially implement (e.g., Anthropic supports
 * executeWithCachedPrefix via cache_control but not prewarm/list/drop).
 *
 * Consumers check capability with instanceof before calling:
 *   if ($llm instanceof AI_LLM_AdvancedInterface) {
 *       $llm->executeWithCachedPrefix(...);
 *   }
 *
 * Providers that don't support a method MUST throw
 * AI_LLM_Exception_NotSupported with a clear message rather than silently
 * falling back. This makes the capability boundary explicit.
 */
interface AI_LLM_AdvancedInterface
{
	/**
	 * Execute a model call with an explicitly cached system prefix.
	 *
	 * On providers with native prefix caching (local KV-cache-aware servers,
	 * Anthropic prompt caching via cache_control), the system prefix is
	 * not retokenized/reprocessed on subsequent calls with the same cacheKey.
	 *
	 * On providers without prefix caching, this method MAY fall back to a
	 * regular executeModel call with the prefix as instructions — but the
	 * adapter should declare via supportsPrefixCache() whether this is the
	 * case.
	 *
	 * @method executeWithCachedPrefix
	 * @param {string} $cacheKey      Stable identifier for the prefix.
	 *                                Same key on subsequent calls reuses cache.
	 * @param {string} $systemPrefix  The system prefix to cache.
	 * @param {array}  $inputs        Multimodal inputs (same shape as executeModel).
	 * @param {array}  $options       Same as executeModel, plus:
	 *                                  prefixTtl: seconds (provider-dependent)
	 * @return {string|integer}       Model output, or async request index.
	 */
	public function executeWithCachedPrefix($cacheKey, $systemPrefix, array $inputs, array $options = array());

	/**
	 * Whether this adapter has native prefix caching.
	 * Adapters that fall back to plain executeModel return false.
	 *
	 * @method supportsPrefixCache
	 * @return {boolean}
	 */
	public function supportsPrefixCache();

	/**
	 * Prewarm a prefix into the model's cache without generating output.
	 *
	 * Useful for loading large system contexts ahead of time so subsequent
	 * calls return immediately. Hosted providers usually don't support this
	 * directly and should throw AI_LLM_Exception_NotSupported.
	 *
	 * @method prewarmPrefix
	 * @param {string} $cacheKey
	 * @param {string} $systemPrefix
	 * @param {array}  [$options]
	 * @return {boolean}  true on success
	 * @throws AI_LLM_Exception_NotSupported on hosted providers
	 */
	public function prewarmPrefix($cacheKey, $systemPrefix, array $options = array());

	/**
	 * List currently-cached prefixes by cache key.
	 *
	 * Local providers track this. Hosted providers usually can't and
	 * should throw AI_LLM_Exception_NotSupported.
	 *
	 * @method listCachedPrefixes
	 * @return {array}  array of cacheKey => metadata
	 * @throws AI_LLM_Exception_NotSupported
	 */
	public function listCachedPrefixes();

	/**
	 * Explicitly evict a cached prefix.
	 *
	 * @method dropCachedPrefix
	 * @param {string} $cacheKey
	 * @return {boolean}  true if evicted, false if not present
	 * @throws AI_LLM_Exception_NotSupported on providers without explicit eviction
	 */
	public function dropCachedPrefix($cacheKey);
}

/**
 * Thrown when an optional Advanced method isn't supported by the adapter.
 * Consumers should catch this when probing for capabilities.
 */
class AI_LLM_Exception_NotSupported extends Exception {}
