# Scaled dot-product attention

Attention compares every query with every key. The score for a pair is the dot product of the query and the key vectors.

## Why we scale

When the dimension d_k is large, dot products grow large and their variance grows with d_k. Large scores push the softmax into saturation, where gradients become tiny. Dividing the scores by the square root of d_k keeps the variance near one, so the softmax stays in a useful range and training is stable.
