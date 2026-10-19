"""The latent-correlation estimator must recover a correlation it is given.

The measurement only means something if the method returns the right number on data where
the right number is known. Synthetic players: a latent normal X correlated rho with the
game's miss z; a yes/no stat is X above the player's own threshold (base rates 0.2-0.7,
like touchdowns). The pooled cov/phi(c) estimate should land on rho.
"""
import math
import random
from statistics import NormalDist, mean

import prop_correlation as pc

N = NormalDist()


def test_normal_scores_are_rank_based_and_centred():
    z = pc.normal_scores([10.0, 50.0, 30.0, 30.0])
    assert z[0] < z[2] == z[3] < z[1]
    assert abs(sum(z)) < 1e-9


def test_latent_estimator_recovers_a_known_correlation():
    rng = random.Random(7)
    rho = 0.3
    cov_sum = phi_sum = 0.0
    for _ in range(2500):  # players
        p = rng.uniform(0.2, 0.7)
        cut = N.inv_cdf(1 - p)
        zs, hits = [], []
        for _ in range(16):  # games
            z = rng.gauss(0, 1)
            x = rho * z + math.sqrt(1 - rho * rho) * rng.gauss(0, 1)
            zs.append(z)
            hits.append(1.0 if x > cut else 0.0)
        ph = mean(hits)
        if not 0 < ph < 1:
            continue
        c = N.inv_cdf(1 - ph)
        cov_sum += mean((h - ph) * (z - mean(zs)) for h, z in zip(hits, zs)) * len(hits)
        phi_sum += N.pdf(c) * len(hits)
    estimate = cov_sum / phi_sum
    assert abs(estimate - rho) < 0.03, estimate
